import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "./firebase";
import { logout } from "./auth";

const sidebarItems = [
  "Overview",
  "Students",
  "Cases",
  "In Progress",
  "Discrepancies",
  "Imports",
  "Reports",
  "Monitoring",
  "Evidence Vault",
  "Audit Logs",
  "Settings"
];

function evaluateDoor(doorWidthInches) {
  return Number(doorWidthInches) >= 32;
}

function evaluateRamp(angleDegrees) {
  const radians = (Number(angleDegrees) * Math.PI) / 180;
  const tangent = Math.tan(radians);

  if (!Number.isFinite(tangent) || tangent <= 0) {
    return false;
  }

  const slopeRatio = 1 / tangent;
  return slopeRatio >= 12;
}

function calculateSlopeRatio(angleDegrees) {
  const radians = (Number(angleDegrees) * Math.PI) / 180;
  const tangent = Math.tan(radians);
  if (!Number.isFinite(tangent) || tangent <= 0) {
    return 0;
  }
  return 1 / tangent;
}

function generateRawReport({ buildingName, doorWidth, rampAngle, inspectorName }) {
  const slopeRatio = calculateSlopeRatio(rampAngle);
  const doorPass = evaluateDoor(doorWidth);
  const rampPass = evaluateRamp(rampAngle);

  return `ADA Inspection Report
Building: ${buildingName}
Inspector: ${inspectorName}
Timestamp: ${new Date().toLocaleString()}

Door Width: ${Number(doorWidth).toFixed(1)} in (${doorPass ? "Compliant" : "Non-compliant"})
Ramp Angle: ${Number(rampAngle).toFixed(2)} deg
Calculated Ramp Slope: 1:${slopeRatio.toFixed(1)} (${rampPass ? "Compliant" : "Non-compliant"})

ADA Standards Referenced:
- Door clear width minimum: 32 in
- Ramp maximum slope: 1:12

Notes:
Measurements gathered through ADA Vision hardware module and transmitted over Bluetooth.
This report is generated for internal compliance evaluation and pre-audit review.`;
}

function summarizeReport({ doorPass, rampPass, buildingName }) {
  if (doorPass && rampPass) {
    return `Summary:
${buildingName} currently passes ADA checks for both inspected items.
The door width meets minimum clearance and the ramp slope is within 1:12 limit.`;
  }
  if (!doorPass && !rampPass) {
    return `Summary:
${buildingName} fails ADA checks for both the door and ramp.
The door is too narrow and the ramp is too steep, so corrective work is required before compliance.`;
  }
  if (!doorPass) {
    return `Summary:
${buildingName} fails ADA door clearance.
Ramp slope is acceptable, but the doorway width must be widened to at least 32 inches.`;
  }
  return `Summary:
${buildingName} fails ADA ramp slope.
Door width is compliant, but the ramp must be adjusted to be no steeper than 1:12.`;
}

export default function App() {
  const [activeMenu, setActiveMenu] = useState("Overview");
  const [authUser, setAuthUser] = useState(null);
  const [authChecking, setAuthChecking] = useState(true);

  const [buildingName, setBuildingName] = useState("City Hall");
  const [inspectorName, setInspectorName] = useState("Bilal Salman");
  const [doorWidth, setDoorWidth] = useState(29);
  const [rampAngle, setRampAngle] = useState(6.2);
  const [bluetoothState, setBluetoothState] = useState("Not connected");
  const [reportText, setReportText] = useState("");
  const [summaryText, setSummaryText] = useState("Click Generate Summary after building a report.");
  const [logs, setLogs] = useState([]);

  const doorPass = evaluateDoor(doorWidth);
  const rampPass = evaluateRamp(rampAngle);
  const slopeRatio = calculateSlopeRatio(rampAngle);

  const casesTotal = logs.length || 1;
  const compliantCount = logs.filter((item) => item.doorPass && item.rampPass).length;
  const actionRequired = logs.filter((item) => !item.doorPass || !item.rampPass).length;

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setAuthUser(user);
      setAuthChecking(false);
      if (!user) {
        window.location.href = "/login.html";
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const savedLogs = localStorage.getItem("adaVisionLogs");
    if (savedLogs) {
      try {
        const parsed = JSON.parse(savedLogs);
        if (Array.isArray(parsed)) {
          setLogs(parsed);
        }
      } catch (error) {
        console.error("Unable to parse saved logs", error);
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("adaVisionLogs", JSON.stringify(logs));
  }, [logs]);

  const exposureValue = useMemo(() => {
    return (actionRequired * 1200 + (rampPass && doorPass ? 400 : 0)).toLocaleString();
  }, [actionRequired, rampPass, doorPass]);

  async function handleLogout() {
    await logout();
    window.location.href = "/login.html";
  }

  async function connectBluetooth() {
    if (!("bluetooth" in navigator)) {
      setBluetoothState("Web Bluetooth is not available in this browser.");
      return;
    }

    try {
      setBluetoothState("Connecting...");
      await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: ["battery_service"]
      });
      setBluetoothState("Device selected. Ready for your sensor stream.");
    } catch (error) {
      setBluetoothState(`Connection canceled: ${error.message}`);
    }
  }

  function runComplianceCheck() {
    const entry = {
      id: Date.now(),
      buildingName,
      inspectorName,
      doorWidth: Number(doorWidth),
      rampAngle: Number(rampAngle),
      slopeRatio: Number(slopeRatio.toFixed(1)),
      doorPass,
      rampPass,
      overallPass: doorPass && rampPass,
      timestamp: new Date().toLocaleString()
    };
    setLogs((prev) => [entry, ...prev].slice(0, 50));
  }

  function generateReport() {
    const rawReport = generateRawReport({
      buildingName,
      doorWidth,
      rampAngle,
      inspectorName
    });
    setReportText(rawReport);
  }

  function generateSummary() {
    const summary = summarizeReport({ doorPass, rampPass, buildingName });
    setSummaryText(summary);
  }

  if (authChecking) {
    return <main className="auth-page">Checking session...</main>;
  }

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <h2>ADA Vision</h2>
          <p>Title IV Compliance</p>
        </div>
        <nav className="menu">
          {sidebarItems.map((item) => (
            <button
              key={item}
              className={`menu-item ${activeMenu === item ? "active" : ""}`}
              onClick={() => setActiveMenu(item)}
            >
              {item}
            </button>
          ))}
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>ADA Vision Inspection Dashboard</h1>
          <div className="actions">
            <span className="badge">Light</span>
            <span className="badge">{authUser?.email || "Inspector"}</span>
            <button className="btn btn-outline" onClick={handleLogout}>
              Sign out
            </button>
          </div>
        </header>

        <section className="grid-cards">
          <article className="stat-card">
            <p className="stat-title">Total Cases</p>
            <p className="stat-value">{casesTotal}</p>
            <p className="stat-meta">All ADA checks</p>
          </article>
          <article className="stat-card">
            <p className="stat-title">In Progress</p>
            <p className="stat-value">1</p>
            <p className="stat-meta">Active inspection</p>
          </article>
          <article className="stat-card">
            <p className="stat-title">Action Required</p>
            <p className="stat-value">{actionRequired}</p>
            <p className="stat-meta">Needs remediation</p>
          </article>
          <article className="stat-card">
            <p className="stat-title">Exposure</p>
            <p className="stat-value">${exposureValue}</p>
            <p className="stat-meta">Open liability estimate</p>
          </article>
        </section>

        <section className="panel-grid">
          <article className="panel">
            <h3>Live Measurements</h3>
            <p>Connect your ESP32/Arduino stream or enter values manually.</p>
            <div className="measurement-grid">
              <div className="metric-box">
                <strong>Door Width (inches)</strong>
                <p className="metric-value">{Number(doorWidth).toFixed(1)} in</p>
                <p className={`metric-result ${doorPass ? "ok" : "bad"}`}>
                  {doorPass ? "Compliant (>= 32 in)" : "Non-compliant (< 32 in)"}
                </p>
              </div>
              <div className="metric-box">
                <strong>Ramp Slope</strong>
                <p className="metric-value">1:{slopeRatio.toFixed(1)}</p>
                <p className={`metric-result ${rampPass ? "ok" : "bad"}`}>
                  {rampPass ? "Compliant (>= 1:12)" : "Non-compliant (< 1:12)"}
                </p>
              </div>
            </div>
            <div className="row">
              <input
                type="text"
                value={buildingName}
                onChange={(event) => setBuildingName(event.target.value)}
                placeholder="Building name"
              />
              <input
                type="text"
                value={inspectorName}
                onChange={(event) => setInspectorName(event.target.value)}
                placeholder="Inspector name"
              />
            </div>
            <div className="row" style={{ marginTop: "8px" }}>
              <input
                type="number"
                min="0"
                step="0.1"
                value={doorWidth}
                onChange={(event) => setDoorWidth(event.target.value)}
                placeholder="Door width in inches"
              />
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={rampAngle}
                onChange={(event) => setRampAngle(event.target.value)}
                placeholder="Ramp angle in degrees"
              />
            </div>
            <div className="row" style={{ marginTop: "10px" }}>
              <button className="btn btn-outline" onClick={connectBluetooth}>
                Connect Bluetooth
              </button>
              <button className="btn btn-primary" onClick={runComplianceCheck}>
                Save Inspection Log
              </button>
            </div>
            <p style={{ marginTop: "9px", marginBottom: 0, fontSize: "0.85rem" }}>
              Bluetooth status: <strong>{bluetoothState}</strong>
            </p>
          </article>

          <article className="panel">
            <h3>Inspection Logs</h3>
            <table className="log-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Door</th>
                  <th>Ramp</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {logs.length === 0 ? (
                  <tr>
                    <td colSpan="4">No logs yet. Save an inspection to start tracking history.</td>
                  </tr>
                ) : (
                  logs.slice(0, 8).map((log) => (
                    <tr key={log.id}>
                      <td>{log.timestamp}</td>
                      <td>{log.doorWidth} in</td>
                      <td>1:{log.slopeRatio}</td>
                      <td className={log.overallPass ? "ok" : "bad"}>
                        {log.overallPass ? "Pass" : "Fail"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </article>
        </section>

        <section className="bottom-grid">
          <article className="panel">
            <h3>Raw Report Generator</h3>
            <p>Generate official-style report text for records and audits.</p>
            <div className="row">
              <textarea
                value={reportText}
                onChange={(event) => setReportText(event.target.value)}
                placeholder="Generated report will appear here..."
              />
            </div>
            <div className="row" style={{ marginTop: "10px" }}>
              <button className="btn btn-primary" onClick={generateReport}>
                Generate Report
              </button>
            </div>
          </article>

          <article className="panel">
            <h3>AI Summary</h3>
            <p>Convert dense report text into concise plain-English findings.</p>
            <div className="summary-box">{summaryText}</div>
            <div className="row" style={{ marginTop: "10px" }}>
              <button className="btn btn-primary" onClick={generateSummary}>
                Generate Summary
              </button>
            </div>
          </article>
        </section>
      </main>
    </div>
  );
}
