import React, { useEffect, useState } from 'react';
import axios from 'axios';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  BarElement,
  ArcElement,
  Filler
} from 'chart.js';
import { Line, Bar } from 'react-chartjs-2';
import './App.css';
import logoImage from './assets/logo.png';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

function App() {
  //  React State Variables 
  const [summary, setSummary] = useState(null); // Holds the main dashboard numbers
  const [forecast, setForecast] = useState(null); // Holds the AI's 6-month prediction
  const [loading, setLoading] = useState(true); // "Loading Analytics Suite..." text
  const [explainMode, setExplainMode] = useState('forecast'); // 'forecast', 'global', 'local'
  const [isModalOpen, setIsModalOpen] = useState(false); // upload popup

  // Variables to hold the user's File Upload form data
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadMonth, setUploadMonth] = useState("April");
  const [uploadYear, setUploadYear] = useState("2025");
  const [processingStatus, setProcessingStatus] = useState({ status: 'idle', percentage: 0 }); // Tracks the 0-100% loading bar

  // Variables for the "What-If" Game
  const [priceChange, setPriceChange] = useState(0);
  const [demandSurge, setDemandSurge] = useState(0);
  const [fixedCostRatio, setFixedCostRatio] = useState(15); // Default 15%
  const [variableCostRatio, setVariableCostRatio] = useState(60); // Default 60%
  const [scenarioForecast, setScenarioForecast] = useState(null);
  const [scenarioLoading, setScenarioLoading] = useState(false);

  // "What-If" sliders (price & demand) to the Python server to get a simulated forecast.
  const fetchScenario = async () => {
    try {
      setScenarioLoading(true);
      const res = await axios.post('http://15.252.142.167:8000/api/what-if', {
        price_change_pct: priceChange,
        demand_surge_pct: demandSurge,
        fixed_cost_ratio: fixedCostRatio / 100,
        variable_cost_ratio: variableCostRatio / 100
      });
      setScenarioForecast(res.data.predictions);
    } catch (error) {
      console.error("Error fetching scenario", error);
    } finally {
      setScenarioLoading(false);
    }
  };

  // main dashboard math and the AI forecast.
  const fetchData = async (retries = 3) => {
    try {
      // Fetch Summary 
      const sumRes = await axios.get('http://15.252.142.167:8000/api/summary');
      setSummary(sumRes.data);

      // fetch the complex Forecast
      const foreRes = await axios.get('http://15.252.142.167:8000/api/forecast');
      setForecast(foreRes.data);
    } catch (error) {
      console.error("Error fetching data", error);
      if (retries > 0) {
        console.log(`Backend not ready. Retrying... (${retries} attempts left)`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        await fetchData(retries - 1);
      } else {
        console.error("Failed to connect to backend after multiple attempts.");
        alert("Cannot connect to the backend server. Please ensure the Python server is running.");
      }
    }
  };

  // useEffect runs automatically. The empty [] bracket means "Only run this ONE time when the user first opens the website."
  useEffect(() => {
    setLoading(true);
    fetchData().finally(() => setLoading(false));
  }, []);

  // processing status
  useEffect(() => {
    let interval;
    if (processingStatus.status === 'processing') {
      interval = setInterval(async () => {
        try {
          const res = await axios.get('http://15.252.142.167:8000/api/process-status');
          setProcessingStatus(res.data);
          if (res.data.status === 'idle' && res.data.percentage === 100) {
            clearInterval(interval);
            fetchData(); // Refresh dashboard
          }
        } catch (e) {
          console.error("Status check failed", e);
        }
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [processingStatus.status]);

  // bundles up the User's Excel file, Month, and Year into a package, mails it to the Python server.
  const handleUpload = async () => {
    if (!uploadFile) return;

    const formData = new FormData();
    formData.append('file', uploadFile);
    formData.append('month', uploadMonth);
    formData.append('year', uploadYear);

    try {
      setProcessingStatus({ status: 'processing', percentage: 0 });
      const res = await axios.post('http://15.252.142.167:8000/api/upload', formData);
      if (res.data.error) {
        setProcessingStatus({ status: 'error', percentage: 0, error: res.data.error });
      }
    } catch (error) {
      console.error("Upload failed", error);
      let errMsg = typeof error.response?.data?.detail === "string"
        ? error.response.data.detail
        : error.message;
      alert(`Upload failed: ${errMsg}. Check console.`);
      setProcessingStatus({ status: 'error', percentage: 0, error: errMsg });
    }
  };

  if (loading && !summary) return <div className="loading-screen">Loading Analytics Suite...</div>;

  // --- CHART DATA PREPARATION ---

  // 1. Sales Trend
  const salesLabels = summary?.trend?.map(d => d.Month) || [];
  const salesData = summary?.trend?.map(d => d.Value) || [];
  // Dynamic Profit Calculation based on live sliders
  const currentTotalCostRatio = (fixedCostRatio + variableCostRatio) / 100;
  const currentTotalSales = summary?.total_sales || 0;
  const currentTotalProfit = currentTotalSales * (1 - currentTotalCostRatio);
  const currentTotalCost = currentTotalSales * currentTotalCostRatio;

  const profitData = summary?.trend?.map(d => d.Value * (1 - currentTotalCostRatio)) || [];

  const trendChartData = {
    labels: salesLabels,
    datasets: [
      {
        label: 'Revenue',
        data: salesLabels.map((_, i) => salesData[i]),
        borderColor: '#10b981',
        backgroundColor: 'rgba(16, 185, 129, 0.1)',
        tension: 0.3,
        fill: true,
        pointRadius: 0,
        pointHoverRadius: 6
      },
      {
        label: 'Profit (Simulated)',
        data: profitData,
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
        tension: 0.3,
        fill: true,
        pointRadius: 0,
        pointHoverRadius: 6
      }
    ],
  };

  // 2. 6-Month Forecast 
  const forecastLabels = forecast?.predictions?.map(p => p.date) || [];
  const forecastVals = forecast?.predictions?.map(p => p.value) || [];

  const forecastChartData = {
    labels: forecastLabels,
    datasets: [
      {
        label: 'Projected Revenue (XGBoost)',
        data: forecastVals,
        borderColor: '#f472b6',
        backgroundColor: 'rgba(244, 114, 182, 0.15)',
        borderDash: [6, 6],
        tension: 0.4,
        pointBackgroundColor: '#f472b6',
        pointRadius: 5,
        fill: true
      }
    ]
  };

  if (scenarioForecast) {
    forecastChartData.datasets.push({
      label: 'Simulated Revenue',
      data: scenarioForecast.map(p => p.value),
      borderColor: '#f59e0b',
      backgroundColor: 'rgba(245, 158, 11, 0.15)',
      tension: 0.4,
      pointBackgroundColor: '#f59e0b',
      pointRadius: 5,
      fill: 'origin'
    });
    forecastChartData.datasets.push({
      label: 'Simulated Profit',
      data: scenarioForecast.map(p => p.profit),
      borderColor: '#0ea5e9',
      backgroundColor: 'rgba(14, 165, 233, 0.15)',
      tension: 0.4,
      pointBackgroundColor: '#0ea5e9',
      pointRadius: 4,
      fill: '-1'
    });
  }

  // 3. SHAP CHART 
  const shapLabels = forecast?.shap_summary?.map(s => s.feature) || [];
  const shapVals = forecast?.shap_summary?.map(s => s.importance) || [];
  const shapPcts = forecast?.shap_summary?.map(s => s.contribution_pct?.toFixed(1) + '%') || [];

  const shapBarColours = [
    '#8b5cf6', '#f472b6', '#10b981', '#3b82f6',
    '#f59e0b', '#ef4444', '#06b6d4'
  ];

  const shapChartData = {
    labels: shapLabels,
    datasets: [
      {
        label: 'Average Impact on Sales Forecast (LKR)',
        data: shapVals,
        backgroundColor: shapBarColours.slice(0, shapLabels.length),
        borderRadius: 6
      }
    ]
  };

  // Helper to format SHAP impacts into readable LKR strings
  const formatImpactValue = (impact) => {
    if (impact == null) return '';
    const sign = impact >= 0 ? '+' : '-';
    const absVal = Math.abs(impact);

    if (absVal >= 1000000) {
      return `${sign} LKR ${(absVal / 1000000).toFixed(2)}M`;
    }
    if (absVal >= 1000) {
      return `${sign} LKR ${(absVal / 1000).toFixed(1)}K`;
    }
    return `${sign} LKR ${Math.floor(absVal).toLocaleString()}`;
  };

  // LOCAL SHAP CHART (Impact on next month)
  const localLabels = forecast?.shap_waterfall?.map(s => {
    return `${s.feature} (${formatImpactValue(s.impact)})`;
  }) || [];
  const localVals = forecast?.shap_waterfall?.map(s => s.impact) || [];

  const localChartData = {
    labels: localLabels,
    datasets: [
      {
        label: 'Positive Impact (+ LKR)',
        data: localVals.map(v => v > 0 ? v : null),
        backgroundColor: '#10b981',
        borderRadius: 6
      },
      {
        label: 'Negative Impact (- LKR)',
        data: localVals.map(v => v < 0 ? v : null),
        backgroundColor: '#ef4444',
        borderRadius: 6
      }
    ]
  };

  // 4. Cash Flow (Inflow vs Outflow)
  const cashFlowChartData = {
    labels: ['Net Profit', 'Total Expenses'],
    datasets: [{
      label: 'Financial Breakdown',
      data: [currentTotalProfit, currentTotalCost],
      backgroundColor: ['#3b82f6', '#ef4444'],
      borderRadius: 6
    }]
  };

  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top', labels: { color: '#94a3b8' } },
      tooltip: {
        backgroundColor: '#1e293b',
        titleColor: '#e2e8f0',
        bodyColor: '#e2e8f0',
        borderColor: 'rgba(255,255,255,0.1)',
        borderWidth: 1,
        padding: 12
      }
    },
    scales: {
      y: {
        ticks: { color: '#64748b' },
        grid: { color: 'rgba(148, 163, 184, 0.05)' },
        beginAtZero: true
      },
      x: {
        ticks: { color: '#64748b' },
        grid: { display: false }
      }
    }
  };

  // --- WEBSITE LAYOUT (JSX) ---

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-branding" style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
          <img src={logoImage} alt="SalesSense Logo" style={{ height: '56px', objectFit: 'contain', borderRadius: '8px' }} />
          <div>
            <h1 className="app-title" style={{ margin: 0 }}>SalesSense</h1>
            <p className="app-subtitle" style={{ margin: 0 }}>ML-Based Sales Forecasting System</p>
          </div>
        </div>

        <div className="header-controls">
          <button className="upload-header-btn" onClick={() => setIsModalOpen(true)}>
            Upload New Data
          </button>
        </div>
      </header>

      <div className="charts-grid">
        <div className="card">
          <h2 className="card-title">Financial Performance History</h2>
          <div className="chart-container">
            <Line options={commonOptions} data={trendChartData} />
          </div>
          
          <div className="card-footer-stats" style={{ display: 'flex', gap: '2rem', marginTop: '1.5rem', paddingTop: '1.5rem', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
            <div className="stat-item">
              <p style={{ color: '#94a3b8', fontSize: '0.8rem', marginBottom: '0.25rem', fontWeight: 500 }}>Total Revenue</p>
              <p style={{ color: '#10b981', fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>
                {currentTotalSales?.toLocaleString('en-US', { style: 'currency', currency: 'LKR', maximumFractionDigits: 0 })}
              </p>
            </div>
            <div className="stat-item">
              <p style={{ color: '#94a3b8', fontSize: '0.8rem', marginBottom: '0.25rem', fontWeight: 500 }}>Estimated Profit</p>
              <p style={{ color: '#3b82f6', fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>
                {currentTotalProfit?.toLocaleString('en-US', { style: 'currency', currency: 'LKR', maximumFractionDigits: 0 })}
              </p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header-flex">
            <h2 className="card-title forecast-title">
              {explainMode === 'forecast' ? "6-Month Forecast" :
                explainMode === 'global' ? "What Drives Sales (Overview)" :
                  "Next Month's Exact Calculation"}
            </h2>

            <div className="toggle-group" style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                className={`toggle-btn ${explainMode === 'forecast' ? 'active' : ''}`}
                onClick={() => setExplainMode('forecast')}
              >
                Forecast
              </button>
              <button
                className={`toggle-btn ${explainMode === 'global' ? 'active' : ''}`}
                onClick={() => setExplainMode('global')}
              >
                What Drives Sales
              </button>
              <button
                className={`toggle-btn ${explainMode === 'local' ? 'active' : ''}`}
                onClick={() => setExplainMode('local')}
              >
                Next Month's Calculation
              </button>
            </div>
          </div>

          <div className="chart-container">
            {explainMode === 'global' && <Bar options={commonOptions} data={shapChartData} />}

            {explainMode === 'local' && (
              <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px', fontSize: '0.9rem', color: '#94a3b8' }}>
                  <span>Base Prediction: {(forecast?.base_value || 0).toLocaleString('en-US', { style: 'currency', currency: 'LKR', maximumFractionDigits: 0 })}</span>
                  <span style={{ color: '#e2e8f0', fontWeight: 'bold' }}>Final Prediction: {((forecast?.base_value || 0) + localVals.reduce((a, b) => a + b, 0)).toLocaleString('en-US', { style: 'currency', currency: 'LKR', maximumFractionDigits: 0 })}</span>
                </div>
                <div style={{ flex: 1, position: 'relative' }}>
                  <Bar
                    options={{
                      ...commonOptions,
                      indexAxis: 'y',
                      scales: {
                        x: { ...commonOptions.scales.x, stacked: true },
                        y: { ...commonOptions.scales.y, stacked: true }
                      }
                    }}
                    data={localChartData}
                  />
                </div>
              </div>
            )}

            {explainMode === 'forecast' && <Line options={commonOptions} data={forecastChartData} />}
          </div>

          {explainMode === 'global' && (
            <p className="shap-desc">
              <strong>What drives your business?</strong> This chart ranks your metrics by how much they change the AI's mind. For example, a tall bar for 'Average Recent Sales' means that your recent sales trend is the biggest clue the AI uses to predict your future revenue.
            </p>
          )}

          {explainMode === 'local' && (
            <p className="shap-desc" style={{ marginTop: '1rem', fontSize: '0.9rem', color: '#94a3b8' }}>
              <strong>How did the AI calculate next month's forecast?</strong> The AI started with a baseline average, then looked at your current metrics. Green bars show metrics giving you a revenue boost, while red bars are dragging your expected revenue down.
            </p>
          )}

          {explainMode === 'forecast' && (
            <div className="scenario-controls" style={{ marginTop: '1.5rem', padding: '1rem', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
              <h3 style={{ fontSize: '1rem', color: '#e2e8f0', marginBottom: '1rem' }}>Scenario Simulator (What-If)</h3>
              <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '200px' }}>
                  <label style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8', fontSize: '0.85rem', marginBottom: '0.5rem', fontWeight: 500 }}>
                    <span>Price Adjustment</span>
                    <span style={{ color: priceChange >= 0 ? '#10b981' : '#ef4444' }}>{priceChange > 0 ? '+' : ''}{priceChange}%</span>
                  </label>
                  <input type="range" min="-50" max="50" value={priceChange} onChange={(e) => setPriceChange(Number(e.target.value))} style={{ width: '100%', accentColor: '#3b82f6' }} />
                </div>
                <div style={{ flex: 1, minWidth: '200px' }}>
                  <label style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8', fontSize: '0.85rem', marginBottom: '0.5rem', fontWeight: 500 }}>
                    <span>Demand Surge</span>
                    <span style={{ color: demandSurge >= 0 ? '#10b981' : '#ef4444' }}>{demandSurge > 0 ? '+' : ''}{demandSurge}%</span>
                  </label>
                  <input type="range" min="-50" max="50" value={demandSurge} onChange={(e) => setDemandSurge(Number(e.target.value))} style={{ width: '100%', accentColor: '#3b82f6' }} />
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end', minWidth: '140px' }}>
                  <button onClick={fetchScenario} disabled={scenarioLoading} className="upload-header-btn" style={{ padding: '0.6rem 1.2rem', width: '100%', margin: 0, justifyContent: 'center', background: 'linear-gradient(135deg, #3b82f6, #0ea5e9)' }}>
                    {scenarioLoading ? 'Simulating...' : 'Run Simulation'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="bottom-grid">
        <div className="card inventory-card">
          <h2 className="card-title" style={{ color: '#f59e0b' }}>Inventory Forecast (Next Month)</h2>
          <p className="card-desc">Actionable reorder points and safety stock levels.</p>
          <div className="table-responsive">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="text-right">Projected</th>
                  <th className="text-right">Safety Stock</th>
                  <th className="text-right">Reorder Pt</th>
                </tr>
              </thead>
              <tbody>
                {forecast?.inventory_forecast?.map((item, idx) => {
                  const safetyStock = Math.ceil(item.Predicted_Qty_Next_Month * 0.2); // 20% safety margin
                  const reorderPoint = item.Predicted_Qty_Next_Month + safetyStock;
                  return (
                    <tr key={idx}>
                      <td>{item.Product}</td>
                      <td className="text-right val">{item.Predicted_Qty_Next_Month}</td>
                      <td className="text-right">{safetyStock}</td>
                      <td className="text-right">
                        <span className={`badge ${item.Status === 'Stock Up' ? 'badge-warning' : 'badge-success'}`}>
                          {reorderPoint}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card cashflow-card">
          <h2 className="card-title" style={{ color: '#10b981' }}>Proactive Cash Flow Analysis</h2>
          <p className="card-desc">Estimated inflows vs. anticipated outflows.</p>
          <div className="chart-container" style={{ height: '220px' }}>
            <Bar options={{ ...commonOptions, indexAxis: 'y' }} data={cashFlowChartData} />
          </div>
          <div className="cashflow-summary">
            <div className="cash-item"><span>Total Inflow</span> <span className="val">{currentTotalSales?.toLocaleString()}</span></div>
            <div className="cash-item"><span>Total Outflow</span> <span className="val val-danger">-{currentTotalCost?.toLocaleString()}</span></div>
            <div className="cash-item"><span>Net Margin</span> <span className="val" style={{ color: '#3b82f6' }}>{currentTotalProfit?.toLocaleString()}</span></div>
          </div>

          <div className="cost-adjustment-suite" style={{ marginTop: '1.5rem', padding: '1rem', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
            <h3 style={{ fontSize: '0.85rem', color: '#e2e8f0', marginBottom: '1rem', fontWeight: 600 }}>Adjust Expense Ratios (Dynamic Impact)</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8', fontSize: '0.75rem', marginBottom: '0.4rem' }}>
                  <span>Fixed Costs (Rent, Salaries)</span>
                  <span style={{ color: '#8b5cf6', fontWeight: 'bold' }}>{fixedCostRatio}%</span>
                </label>
                <input type="range" min="0" max="100" value={fixedCostRatio} onChange={(e) => setFixedCostRatio(Number(e.target.value))} style={{ width: '100%', accentColor: '#8b5cf6' }} />
              </div>
              <div>
                <label style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8', fontSize: '0.75rem', marginBottom: '0.4rem' }}>
                  <span>Variable Costs (Materials, Shipping)</span>
                  <span style={{ color: '#f472b6', fontWeight: 'bold' }}>{variableCostRatio}%</span>
                </label>
                <input type="range" min="0" max="100" value={variableCostRatio} onChange={(e) => setVariableCostRatio(Number(e.target.value))} style={{ width: '100%', accentColor: '#f472b6' }} />
              </div>
            </div>
            <p style={{ marginTop: '0.8rem', fontSize: '0.7rem', color: '#64748b', fontStyle: 'italic' }}>
              Adjusting these will instantly update all Profit metrics.
            </p>
          </div>
        </div>

        <div className="card top-products-card">
          <h2 className="card-title" style={{ color: '#8b5cf6' }}>Strategic Product Analytics</h2>
          <div className="table-responsive">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Performance</th>
                  <th className="text-right">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {summary?.top_products?.slice(0, 5).map((prod, idx) => (
                  <tr key={idx}>
                    <td style={{ fontSize: '0.85rem' }}>⭐ {prod.Product}</td>
                    <td className="text-right val">
                      {prod.Value.toLocaleString('en-US', { style: 'currency', currency: 'LKR', maximumFractionDigits: 0 })}
                    </td>
                  </tr>
                ))}
                {summary?.underperforming_products?.slice(0, 5).map((prod, idx) => (
                  <tr key={idx}>
                    <td style={{ fontSize: '0.85rem' }}>⚠️ {prod.Product}</td>
                    <td className="text-right val val-danger">
                      {prod.Value.toLocaleString('en-US', { style: 'currency', currency: 'LKR', maximumFractionDigits: 0 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {isModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h2 className="modal-title">Upload Yearly Data</h2>
              <button className="close-btn" onClick={() => setIsModalOpen(false)}>&times;</button>
            </div>

            <div className="form-group">
              <label>Select Month</label>
              <select className="form-select" value={uploadMonth} onChange={(e) => setUploadMonth(e.target.value)}>
                {["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label>Select Year</label>
              <select className="form-select" value={uploadYear} onChange={(e) => setUploadYear(e.target.value)}>
                {["2022", "2023", "2024", "2025", "2026", "2027", "2028", "2029", "2030"].map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label>Excel File (.xlsx)</label>
              <input
                type="file"
                className="form-input"
                accept=".xlsx"
                onChange={(e) => setUploadFile(e.target.files[0])}
              />
            </div>

            <button
              className="upload-button"
              onClick={handleUpload}
              disabled={!uploadFile || processingStatus.status === 'processing'}
            >
              {processingStatus.status === 'processing' ? 'Processing...' : 'Upload & Re-train Modal'}
            </button>

            {processingStatus.status === 'processing' && (
              <div className="progress-container">
                <div className="progress-bar-bg">
                  <div className="progress-bar-fill" style={{ width: `${processingStatus.percentage}%` }}></div>
                </div>
                <p className="progress-text">Processing: {processingStatus.percentage}%</p>
              </div>
            )}

            {processingStatus.status === 'idle' && processingStatus.percentage === 100 && (
              <p className="progress-text" style={{ color: '#10b981', marginTop: '1rem' }}>
                ✓ Re-training Complete! Dashboard updated.
              </p>
            )}

            {processingStatus.status === 'error' && (
              <p className="progress-text" style={{ color: '#ef4444', marginTop: '1rem' }}>
                Error: {processingStatus.error}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
