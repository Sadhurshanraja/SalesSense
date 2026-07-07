from fastapi import FastAPI, UploadFile, File, Form, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import pandas as pd
import numpy as np
import xgboost as xgb
import shap
from sklearn.model_selection import train_test_split
from data_processor import process_all_data
import os
import json
import shutil
from datetime import datetime
import threading

data_lock = threading.Lock() 

app = FastAPI() 

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

CLEAN_FILE = "cleaned_all.csv" # The final, processed summary of all uploaded Excel files stored locally
processing_status = {"status": "idle", "percentage": 0} 

# Background worker that cleans messy Excel files without freezing the server
def run_processing():
    global processing_status
    try:
        def update_progress(p):
            processing_status["percentage"] = p
            
        base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        df = process_all_data(base_dir, progress_callback=update_progress)
        
        clean_path = os.path.join(os.path.dirname(__file__), CLEAN_FILE)
        df.to_csv(clean_path, index=False)
        
        processing_status = {"status": "idle", "percentage": 100, "message": "Success"}
    except Exception as e:
        print(f"Error in background processing: {e}")
        processing_status = {"status": "error", "percentage": 0, "error": str(e)}

# new Excel file uploads from the website
@app.post("/api/upload")
async def upload_file(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    month: str = Form(...),
    year: str = Form(...)
):
    global processing_status
    if processing_status["status"] == "processing":
         return {"error": "A processing task is already running."}
         
    target_filename = f"{year} {month}.xlsx"
    files_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "files"))
    os.makedirs(files_dir, exist_ok=True)
    file_path = os.path.join(files_dir, target_filename)
    
    # Try to open the target file path and save the uploaded data into it
    try:
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
    
    except Exception as e:
        processing_status = {"status": "error", "percentage": 0, "error": f"Failed to save file (might be open in Excel): {str(e)}"}
        return {"error": f"Save failed: {str(e)}"}
        
    processing_status = {"status": "processing", "percentage": 0}
    
        background_tasks.add_task(run_processing)
    
        return {"message": "File uploaded. Processing started.", "filename": target_filename}

@app.get("/api/process-status")
def get_process_status():
    return processing_status

def get_data():
    """
    Helper function to load our cleaned data. 
    It acts like a cache system: if 'cleaned_all.csv' already exists on disk, it loads it instantly. 
    Otherwise, it triggers the heavy processor to build it from scratch by reading the raw files.
    """
    clean_path = os.path.join(os.path.dirname(__file__), CLEAN_FILE)
    
    with data_lock:
        # 1. Fastest path: file already exists
        if os.path.exists(clean_path):
            return pd.read_csv(clean_path)
        
        # 2. Slow path: generate it because it's missing 
        try:
            df = process_all_data(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
            df.to_csv(clean_path, index=False)
            return df
        except Exception as e:
            print(f"Error generating data: {e}")
            return pd.DataFrame() # Return completely empty if it fails
@app.get("/api/sales")
def get_sales():
    df = get_data()
    return df.to_dict(orient="records")

# calculates Total Profit, Trends, and Top Products for the dashboard
@app.get("/api/summary")
def get_summary():
    """
    This endpoint powers the main Dashboard summary cards and charts.
    It crunches the entire historical dataset into key metrics without using AI.
    """
    df = get_data()
    if df.empty:
        return {}
    
    # Standardize the date formats so Pandas can group them by month correctly
    df["DateObj"] = pd.to_datetime(df["Date"], format="%d-%b-%Y")
    
    df["Product"] = df["Product"].str.replace("_x000D_", "", regex=False).str.strip()
    
    total_sales = df["Value"].sum()
    
    # Aggregation: Monthly Trend - Grouping sales by month for the line chart
    monthly = df.groupby(df["DateObj"].dt.to_period("M"))["Value"].sum().reset_index()
    monthly["Month"] = monthly["DateObj"].dt.strftime("%Y-%m")
    
    
    estimated_margin = 0.25 # Assume 25% profit margin generically if not given
    total_profit = total_sales * estimated_margin
    
    monthly["Profit"] = monthly["Value"] * estimated_margin
    monthly["Cost"] = monthly["Value"] * (1 - estimated_margin)
    
    # Top Products
    product_stats = df.groupby("Product").agg({
        "Value": "sum",
        "Quantity": "sum"
    }).reset_index()
    
    # Count how many months each product appeared in
    product_month_counts = df.groupby("Product")["DateObj"].apply(
        lambda x: x.dt.to_period("M").nunique()
    ).reset_index()
    product_month_counts.columns = ["Product", "MonthCount"]
    product_stats = product_stats.merge(product_month_counts, on="Product", how="left")
    
    top_products = product_stats.nlargest(10, "Value")
    
    # Underperforming Products 
    meaningful_products = product_stats[
        (product_stats["Value"] >= 10000) & (product_stats["MonthCount"] >= 3)
    ]
    underperforming_products = meaningful_products.nsmallest(10, "Value")
    
    return {
        "total_sales": total_sales,
        "total_profit": total_profit,
        "total_cost": total_sales * (1 - estimated_margin),
        "trend": monthly[["Month", "Value", "Profit", "Cost"]].to_dict(orient="records"),
        "top_products": top_products.to_dict(orient="records"),
        "underperforming_products": underperforming_products.to_dict(orient="records")
    }

#  trains the XGBoost AI Brain and predicts 6 months into the future
@app.get("/api/forecast")
def get_forecast():
    df = get_data()
    if df.empty:
        return {"predictions": [], "inventory_alerts": [], "shap_values": []}

    df["DateObj"] = pd.to_datetime(df["Date"], format="%d-%b-%Y")
    
    # Clean Excel artifacts from product names
    df["Product"] = df["Product"].str.replace("_x000D_", "", regex=False).str.strip()
    
    # GROUP BY MONTH
    monthly_data = df.groupby(df["DateObj"].dt.to_period("M")).agg({
        "Value": "sum",
        "Quantity": "sum"
    }).reset_index()
    
    monthly_data["MonthNum"]    = range(len(monthly_data))
    monthly_data["MonthOfYear"] = monthly_data["DateObj"].dt.month
    
    # FEATURE ENGINEERING: Giving the AI context.
    
    monthly_data["Lag1"]         = monthly_data["Value"].shift(1) 
    monthly_data["Lag2"]         = monthly_data["Value"].shift(2) 
    monthly_data["Lag3"]         = monthly_data["Value"].shift(3) 
    monthly_data["RollingMean3"] = monthly_data["Value"].rolling(window=3).mean().shift(1) # Average of last 3 months
    monthly_data["RollingStd3"]  = monthly_data["Value"].rolling(window=3).std().shift(1) # Spread/Volatility of last 3 months
    monthly_data = monthly_data.dropna().reset_index(drop=True) # Drop initial rows that don't have enough history to calculate lags

    # These are the specific columns the AI will look at to learn patterns
    features = [
        "MonthNum", "MonthOfYear", "Lag1", "Lag2", "Lag3",
        "RollingMean3", "RollingStd3"
    ]
    X = monthly_data[features] # The "Questions" or Context
    y = monthly_data["Value"]  # The "Answers" or target Sales
    
    predictions = []
    shap_data = []
    
    last_month_num = monthly_data["MonthNum"].max()
    last_date = monthly_data["DateObj"].dt.to_timestamp().max()
    
    # XGBoost Model - This is the core AI Brain. 
    
    model = xgb.XGBRegressor(
        objective='reg:squarederror',
        n_estimators=100, 
        random_state=42   
    )
    model.fit(X, y) # Telling the brain to learn using historical data

    #  Iterative 6-Month Forecast 
        future_preds = []
    last_known   = monthly_data.copy()
    first_month_X = None

    for i in range(1, 7):
        next_date  = last_date + pd.DateOffset(months=i)
        roll_vals3 = last_known["Value"].iloc[-3:]

        # Build the exact same context (Lags, Averages) for the upcoming month
        next_X = pd.DataFrame([{
            "MonthNum":     last_month_num + i,
            "MonthOfYear":  next_date.month,
            "Lag1":         roll_vals3.iloc[-1], 
            "Lag2":         roll_vals3.iloc[-2],
            "Lag3":         roll_vals3.iloc[-3],
            "RollingMean3": roll_vals3.mean(),
            "RollingStd3":  roll_vals3.std()
        }])
        
        if i == 1:
            first_month_X = next_X.copy() # Save the very first future month specifically for SHAP explainability

        # Ask the AI to guess the sales value
        pred = model.predict(next_X)[0]
        future_preds.append(float(pred))
        
        # Automatically add the AI's guess to our "known" list, so the loop can use it for the next pass
        last_known = pd.concat(
            [last_known, pd.DataFrame([{"Value": float(pred)}])],
            ignore_index=True
        )

    #  SHAP Explanation 
    english_names = {
        "MonthNum": "Overall Business Growth",
        "MonthOfYear": "Time of Year (Seasonality)",
        "Lag1": "Sales from Last Month",
        "Lag2": "Sales from 2 Months Ago",
        "Lag3": "Sales from 3 Months Ago",
        "RollingMean3": "Average Sales (Last 90 Days)",
        "RollingStd3": "Market Volatility"
    }

    shap_waterfall = []
    base_value = 0.0

    try:
        explainer     = shap.TreeExplainer(model)
        shap_values   = explainer.shap_values(X)        # numpy array
        mean_abs_shap = np.abs(shap_values).mean(axis=0)
        total_shap    = mean_abs_shap.sum()

        for idx, col in enumerate(X.columns):
            shap_data.append({
                "feature":          english_names.get(col, col),
                "importance":       float(mean_abs_shap[idx]),
                "contribution_pct": float(mean_abs_shap[idx] / total_shap * 100) if total_shap > 0 else 0.0
            })
        shap_data.sort(key=lambda x: x["importance"], reverse=True)
        
        # Local SHAP for the first future month
        bv = explainer.expected_value
        if isinstance(bv, np.ndarray):
            base_value = float(bv[0])
        else:
            base_value = float(bv)
            
        local_shap_vals = explainer.shap_values(first_month_X)[0]
        
        for idx, col in enumerate(first_month_X.columns):
            shap_waterfall.append({
                "feature": english_names.get(col, col),
                "value": round(float(first_month_X[col].iloc[0]), 2),
                "impact": float(local_shap_vals[idx])
            })
            
        shap_waterfall.sort(key=lambda x: abs(x["impact"]), reverse=True)

    except Exception as shap_err:
        print(f"[SHAP Warning] {shap_err}")
        fi       = model.feature_importances_
        total_fi = fi.sum()
        for idx, col in enumerate(X.columns):
            shap_data.append({
                "feature":          english_names.get(col, col),
                "importance":       float(fi[idx]),
                "contribution_pct": float(fi[idx] / total_fi * 100) if total_fi > 0 else 0.0
            })
        shap_data.sort(key=lambda x: x["importance"], reverse=True)


    for i, pred_val in enumerate(future_preds):
        next_val = float(max(pred_val, 0))
        next_date = last_date + pd.DateOffset(months=i+1)
        
        predictions.append({
            "date": next_date.strftime("%Y-%m"),
            "value": next_val,
            "profit": next_val * 0.25
        })
        
    #  INVENTORY RECOMMENDATIONS 
    
    top_prods_list = []
    # Identify the Top 5 best 
    top_5 = df.groupby("Product")["Value"].sum().nlargest(5).index
    
    for prod in top_5:
        p_df = df[df["Product"] == prod].copy()
        if p_df.empty: continue
        
        # Group how many units of this specific product we sold every month
        p_monthly = p_df.groupby(p_df["DateObj"].dt.to_period("M"))["Quantity"].sum().reset_index()
        p_monthly["X"] = range(len(p_monthly))
        
        
        if len(p_monthly) > 1:
             slope = (p_monthly["Quantity"].iloc[-1] - p_monthly["Quantity"].iloc[0]) / len(p_monthly)
             next_qty = p_monthly["Quantity"].iloc[-1] + slope
        else:
            next_qty = p_monthly["Quantity"].mean()
            
        # Deliver a human-readable alert for the store owner
        top_prods_list.append({
            "Product": prod,
            "Predicted_Qty_Next_Month": int(max(next_qty, 0)), # Never recommend negative inventory
            "Status": "Stock Up" if next_qty > 0 else "Sufficient"
        })

    return {
        "message": "6-Month Forecast Generated using XGBoost",
        "predictions": predictions,
        "inventory_forecast": top_prods_list,
        "shap_summary": shap_data,
        "shap_waterfall": shap_waterfall,
        "base_value": base_value
    }

class ScenarioRequest(BaseModel):
    price_change_pct: float
    demand_surge_pct: float
    fixed_cost_ratio: float = 0.15
    variable_cost_ratio: float = 0.60

# The "What-If" 
@app.post("/api/what-if")
def get_what_if_forecast(scenario: ScenarioRequest):
    df = get_data()
    if df.empty:
        return {"predictions": []}

    df["DateObj"] = pd.to_datetime(df["Date"], format="%d-%b-%Y")
    
    monthly_data = df.groupby(df["DateObj"].dt.to_period("M")).agg({
        "Value": "sum",
        "Quantity": "sum"
    }).reset_index()
    
    monthly_data["MonthNum"]    = range(len(monthly_data))
    monthly_data["MonthOfYear"] = monthly_data["DateObj"].dt.month
    
    monthly_data["Lag1"]         = monthly_data["Value"].shift(1)
    monthly_data["Lag2"]         = monthly_data["Value"].shift(2)
    monthly_data["Lag3"]         = monthly_data["Value"].shift(3)
    monthly_data["RollingMean3"] = monthly_data["Value"].rolling(window=3).mean().shift(1)
    monthly_data["RollingStd3"]  = monthly_data["Value"].rolling(window=3).std().shift(1)
    monthly_data = monthly_data.dropna().reset_index(drop=True)

    features = [
        "MonthNum", "MonthOfYear", "Lag1", "Lag2", "Lag3",
        "RollingMean3", "RollingStd3"
    ]
    X = monthly_data[features]
    y = monthly_data["Value"]
    
    last_month_num = monthly_data["MonthNum"].max()
    last_date = monthly_data["DateObj"].dt.to_timestamp().max()
    
    model = xgb.XGBRegressor(
        objective='reg:squarederror',
        n_estimators=100,
        random_state=42
    )
    model.fit(X, y)

    impact_factor = (1 + scenario.price_change_pct / 100.0) * (1 + scenario.demand_surge_pct / 100.0)
    
    future_preds = []
    last_known   = monthly_data.copy()

    for i in range(1, 7):
        next_date  = last_date + pd.DateOffset(months=i)
        roll_vals3 = last_known["Value"].iloc[-3:]

        next_X = pd.DataFrame([{
            "MonthNum":     last_month_num + i,
            "MonthOfYear":  next_date.month,
            "Lag1":         roll_vals3.iloc[-1],
            "Lag2":         roll_vals3.iloc[-2],
            "Lag3":         roll_vals3.iloc[-3],
            "RollingMean3": roll_vals3.mean(),
            "RollingStd3":  roll_vals3.std()
        }])

        pred = model.predict(next_X)[0]
        pred = pred * impact_factor
        future_preds.append(float(pred))
        
        last_known = pd.concat([last_known, pd.DataFrame([{"Value": float(pred)}])], ignore_index=True)

    predictions = []
    total_cost_ratio = scenario.fixed_cost_ratio + scenario.variable_cost_ratio
    
    for i, pred_val in enumerate(future_preds):
        next_val = float(max(pred_val, 0))
        next_date = last_date + pd.DateOffset(months=i+1)
        
        # Calculate profit based on provided ratios
        next_profit = next_val * (1 - total_cost_ratio)
        
        predictions.append({
            "date": next_date.strftime("%Y-%m"),
            "value": next_val,
            "profit": next_profit
        })
        
    return {"predictions": predictions}
