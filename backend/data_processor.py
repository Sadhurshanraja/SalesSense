import pandas as pd
import os
import glob
import re
import warnings

# Suppress openpyxl warnings 
warnings.filterwarnings('ignore', category=UserWarning, module='openpyxl')

def clean_value(val):
    if pd.isna(val):
        return 0.0
    s = str(val).replace(",", "").strip()
    if not s or s == '-':
        return 0.0
    
    match = re.search(r"([\d\.]+)", s)
    if match:
        try:
            return float(match.group(1))
        except:
            return 0.0
    return 0.0

def process_dataframe(df, filename=""):
    # Process a raw dataframe looking for 'Particulars' and extracting sales data.
    print(f"Processing {filename} with shape {df.shape}")
    
    header_row_idx = None
    part_col_idx = None
    
    # 1. Find Header Row
    for r in range(min(50, len(df))):
        row_vals = df.iloc[r].astype(str).values
        for c, val in enumerate(row_vals):
            if "Particulars" in val:
                header_row_idx = r
                part_col_idx = c
                break
        if header_row_idx is not None:
            break
            
    if header_row_idx is None:
        print(f"Skipping {filename}: 'Particulars' not found")
        return pd.DataFrame() # Empty
        
    print(f"Found 'Particulars' at row {header_row_idx}, col {part_col_idx}")
    
    # Extract headers
    headers = df.iloc[header_row_idx].astype(str).values
    
    
    sub_header_row_idx = header_row_idx + 1
    sub_headers = df.iloc[sub_header_row_idx].astype(str).values
    
    # Verify subheaders contain Quantity/Value
    has_qty = any("Quantity" in x for x in sub_headers)
    if not has_qty:
        
        sub_header_row_idx += 1
        if sub_header_row_idx < len(df):
             sub_headers = df.iloc[sub_header_row_idx].astype(str).values
    
    # Build Column Map
    # structure: { "1-May-2024": { "Quantity": col_idx, "Value": col_idx, ... } }
    date_map = {}
    current_date = None
    
    for c in range(part_col_idx + 1, len(headers)):
        h = headers[c].strip()
        
        if h != 'nan' and h != '':
            current_date = h.replace("For ", "").strip()
            if current_date.lower() in ['total', 'grand total']:
                current_date = None
        elif h == 'nan' and current_date:
            pass # Continue using current_date for subsequent columns in the group
            
        if current_date and c < len(sub_headers):
            sub = sub_headers[c].strip()
            if sub in ["Quantity", "Eff. Rate", "Value"]:
                if current_date not in date_map:
                    date_map[current_date] = {}
                date_map[current_date][sub] = c
                
    # Extract Data
    processed_list = []
    data_start_idx = sub_header_row_idx + 1
    
    for r in range(data_start_idx, len(df)):
        row = df.iloc[r]
        product_name = str(row.iloc[part_col_idx]).replace('_x000D_', '').strip()
        
        # Filter junk rows
        if not product_name or product_name.lower() in ['nan', 'none', '', 'total', 'grand total']:
            continue
        if "Finished Goods" in product_name or "Chilli Powder" == product_name: # Categories
             
             pass 
             
        for date, mapping in date_map.items():
            qty = 0.0
            val = 0.0
            rate = 0.0
            
            if "Quantity" in mapping:
                qty = clean_value(row.iloc[mapping["Quantity"]])
            if "Value" in mapping:
                val = clean_value(row.iloc[mapping["Value"]])
            if "Eff. Rate" in mapping:
                rate = clean_value(row.iloc[mapping["Eff. Rate"]])
                
            if qty == 0 and val == 0:
                continue
                
            processed_list.append({
                "Date": date,
                "Product": product_name,
                "Quantity": qty,
                "Rate": rate,
                "Value": val,
                "Source": filename
            })
            
    return pd.DataFrame(processed_list)

def process_all_data(base_dir=None, progress_callback=None):
    if base_dir is None:
        # Default to the root directory where the script is located 
        base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    
    all_data = []
    
    # 2. Process files/*.xlsx
    files_dir = os.path.join(base_dir, "files")
    if os.path.exists(files_dir):
        xlsx_files = glob.glob(os.path.join(files_dir, "*.xlsx"))
        total_files = len(xlsx_files)
        
        for i, xf in enumerate(xlsx_files):
            fname = os.path.basename(xf)
            try:
                df = pd.read_excel(xf, header=None)
                clean_df = process_dataframe(df, fname)
                if not clean_df.empty:
                    all_data.append(clean_df)
            except Exception as e:
                print(f"Error reading {fname}: {e}")
            
            if progress_callback and total_files > 0:
                # Use 90% of the progress for file processing
                progress = int(((i + 1) / total_files) * 90)
                progress_callback(progress)
                
    if not all_data:
        print("No data found in any of the specified sources.")
        return pd.DataFrame()
        
    master_df = pd.concat(all_data, ignore_index=True)
    
    if master_df.empty:
        return master_df
    
    # Standardize Dates
   
    def parse_date(d):
        if isinstance(d, pd.Timestamp):
            return d
        try:
            return pd.to_datetime(d, format="%d-%b-%Y")
        except:
            return pd.to_datetime(d, errors='coerce')
            
    master_df["DateObj"] = master_df["Date"].apply(parse_date)
    # Filter valid dates
    master_df = master_df.dropna(subset=["DateObj"])
    
    # Convert back to consistent string format for API
    master_df["Date"] = master_df["DateObj"].dt.strftime("%d-%b-%Y")
    master_df = master_df.sort_values("DateObj")
    
    if progress_callback:
        progress_callback(100)
    
    return master_df

if __name__ == "__main__":
    df = process_all_data()
    
    if not df.empty:
        print(f"Total Records: {len(df)}")
        print(df.head())
        if "DateObj" in df.columns:
            print("Unique Months:", df["DateObj"].dt.to_period('M').unique())
        
        backend_dir = os.path.dirname(os.path.abspath(__file__))
        out_path = os.path.join(backend_dir, "cleaned_all.csv")
        df.to_csv(out_path, index=False)
        print(f"Saved to {out_path}")
    else:
        print("No records processed. Output file not created.")
