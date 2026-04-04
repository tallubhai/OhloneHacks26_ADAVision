import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc
} from "firebase/firestore";
import { auth, db } from "./firebase";
import { logout } from "./auth";
import { generateAiSummary, generateAiWebsiteDetailedReport } from "./services/aiSummary";

/**
 * @file App.jsx (report / threshold / sensor slice)
 *
 * Data path for demos (see docs/CODEBASE_GUIDE.md):
 * 1. Python bridge POSTs to `/api/sensors/ingest` → server stores latest reading.
 * 2. This app polls `GET /api/sensors/latest` and prepends new rows to `importedReadings`.
 * 3. `buildReportMeasurements()` merges logs + imports (newest first) for the report.
 * 4. `generateRawReport` / `buildRawReport` embed thresholds (`minDoorWidth`, `minSlopeRatio`).
 * 5. `generateSummary` sends that text + the same thresholds and latest numbers to `generateAiSummary`.
 *
 * Ramp math: angle θ → tangent → slope ratio 1:X as run:rise, where X = 1/tan(θ). Larger X = flatter ramp.
 */

const sidebarItems = [
  "Overview",
  "Buildings",
  "Websites",
  "Reports",
  "Settings"
];

/** @returns {string} Local calendar date `YYYY-MM-DD` for inspection date defaults. */
function getTodayIsoDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Door rule: pass when clear width meets or exceeds the configured minimum (typ. 32 in).
 * @param {number} doorWidthInches Observed width in inches.
 * @param {number} [minDoorWidth=32] Required minimum width in inches.
 * @returns {boolean}
 */
function evaluateDoor(doorWidthInches, minDoorWidth = 32) {
  return Number(doorWidthInches) >= Number(minDoorWidth);
}

/**
 * Door clear height: pass when measured height meets or exceeds minimum. Null = not captured.
 * @param {number} doorHeightInches
 * @param {number} [minDoorHeight=80]
 * @returns {boolean|null}
 */
function evaluateDoorHeight(doorHeightInches, minDoorHeight = 80) {
  const doorHeight = Number(doorHeightInches);
  if (!Number.isFinite(doorHeight) || doorHeight <= 0) return null;
  return doorHeight >= Number(minDoorHeight);
}

/**
 * Pathway clear width: pass when width meets or exceeds minimum. Null = not captured.
 * @param {number} pathwayWidthInches
 * @param {number} [minPathwayWidth=36]
 * @returns {boolean|null}
 */
function evaluatePathwayWidth(pathwayWidthInches, minPathwayWidth = 36) {
  const pathwayWidth = Number(pathwayWidthInches);
  if (!Number.isFinite(pathwayWidth) || pathwayWidth <= 0) return null;
  return pathwayWidth >= Number(minPathwayWidth);
}

/**
 * Ramp rule: convert angle to run:rise ratio 1:X; pass when X ≥ minimum (flatter is better).
 * @param {number} angleDegrees Ramp angle from horizontal, degrees.
 * @param {number} [minSlopeRatio=12] Minimum acceptable 1:X (e.g. 12 means 1:12 or flatter).
 * @returns {boolean}
 */
function evaluateRamp(angleDegrees, minSlopeRatio = 12) {
  const radians = (Number(angleDegrees) * Math.PI) / 180;
  const tangent = Math.tan(radians);

  if (!Number.isFinite(tangent) || tangent <= 0) {
    return false;
  }

  const slopeRatio = 1 / tangent;
  return slopeRatio >= Number(minSlopeRatio);
}

/**
 * @param {number} angleDegrees
 * @returns {number} Run:rise ratio 1:X (0 if angle invalid for tan).
 */
function calculateSlopeRatio(angleDegrees) {
  const radians = (Number(angleDegrees) * Math.PI) / 180;
  const tangent = Math.tan(radians);
  if (!Number.isFinite(tangent) || tangent <= 0) {
    return 0;
  }
  return 1 / tangent;
}

/**
 * Build the multi-line inspection string shown in the Reports UI and sent to the AI backend.
 *
 * @param {object} opts
 * @param {string} opts.buildingName
 * @param {string} opts.inspectorName
 * @param {string} opts.inspectionDate
 * @param {string} opts.notes Free-form notes section.
 * @param {Array<{ doorWidth: number, rampAngle: number, timestamp?: string }>} opts.measurements Newest-first list; index 0 is “latest”.
 * @param {number} opts.minDoorWidth Threshold (inches).
 * @param {number} opts.minSlopeRatio Threshold as 1:X.
 * @param {number} opts.minDoorHeight Minimum clear door height (inches).
 * @param {number} opts.minPathwayWidth Minimum pathway width (inches).
 * @returns {string}
 */
function generateRawReport({
  buildingName,
  inspectorName,
  inspectionDate,
  notes,
  measurements,
  selectedCases,
  includeBuildingMeasurements,
  includeBuildingThresholds,
  minDoorWidth,
  minSlopeRatio,
  minDoorHeight,
  minPathwayWidth
}) {
  const latest = measurements[0] || null;
  const latestDoorPass = latest ? evaluateDoor(latest.doorWidth, minDoorWidth) : null;
  const latestRampPass = latest ? evaluateRamp(latest.rampAngle, minSlopeRatio) : null;
  const latestDoorHeightPass = latest ? evaluateDoorHeight(latest.doorHeight, minDoorHeight) : null;
  const latestPathwayPass = latest ? evaluatePathwayWidth(latest.pathwayWidth, minPathwayWidth) : null;
  const latestSlope = latest ? calculateSlopeRatio(latest.rampAngle) : null;
  const latestDoorHeightValue = latest ? Number(latest.doorHeight) : NaN;
  const latestPathwayValue = latest ? Number(latest.pathwayWidth) : NaN;
  const hasDoorHeight = Number.isFinite(latestDoorHeightValue) && latestDoorHeightValue > 0;
  const hasPathwayWidth = Number.isFinite(latestPathwayValue) && latestPathwayValue > 0;
  const doorHeightStatus =
    latestDoorHeightPass === null ? "Not captured" : latestDoorHeightPass ? "Compliant" : "Non-compliant";
  const pathwayStatus =
    latestPathwayPass === null ? "Not captured" : latestPathwayPass ? "Compliant" : "Non-compliant";
  const doorHeightLabel = hasDoorHeight ? `${latestDoorHeightValue.toFixed(1)} in` : "N/A";
  const pathwayLabel = hasPathwayWidth ? `${latestPathwayValue.toFixed(1)} in` : "N/A";
  const chosenCases = Array.isArray(selectedCases) ? selectedCases : [];
  const includeLatestMeasurementSection = Boolean(includeBuildingMeasurements && latest);
  const caseSection =
    chosenCases.length === 0
      ? "No website cases selected for this report."
      : chosenCases
          .map((item, index) => {
            const topIssues = (item.failedChecks || [])
              .slice(0, 3)
              .map((check) => check.help)
              .filter(Boolean)
              .join("; ");
            return `${index + 1}. ${item.url}
   Captured: ${item.createdAtLabel || item.scannedAt || "Unknown time"}
   Violations: ${item.counts?.violations || 0} | Advisory: ${item.counts?.advisory || 0} | Passes: ${item.counts?.passes || 0}
   Top Issues: ${topIssues || "None"}`;
          })
          .join("\n");

  const thresholdsSection = includeBuildingThresholds
    ? `Applied ADA Thresholds:
- Ramp ratio minimum: 1:${minSlopeRatio}
- Door width minimum: ${minDoorWidth} in
- Door clear height minimum: ${minDoorHeight} in
- Pathway clear width minimum: ${minPathwayWidth} in
`
    : "";
  const latestMeasurementSection = includeLatestMeasurementSection
    ? `Latest Measurement: ${latest.timestamp || "Unknown time"}
Ramp Ratio (run:rise): 1:${latestSlope.toFixed(2)} (${latestRampPass ? "Compliant" : "Non-compliant"}; pass if ratio is 1:${minSlopeRatio} or flatter)
Door Width: ${Number(latest.doorWidth).toFixed(1)} in (${latestDoorPass ? "Compliant" : "Non-compliant"}; pass if width is ${minDoorWidth} in or wider)
Door Clear Height: ${doorHeightLabel} (${doorHeightStatus}; pass if height is ${minDoorHeight} in or higher)
Pathway Clear Width: ${pathwayLabel} (${pathwayStatus}; pass if width is ${minPathwayWidth} in or wider)
`
    : "";

  return `ADA Inspection Report
Building: ${buildingName}
Inspector: ${inspectorName}
Inspection Date: ${inspectionDate}
Generated: ${new Date().toLocaleString()}

${thresholdsSection}

${latestMeasurementSection}

Selected Website Cases:
${caseSection}

Notes: ${notes}
`;
}

/**
 * Deterministic fallback summary when Ollama is down or the user has not generated AI text yet.
 * Mirrors pass/fail logic for door width, ramp, door height, and pathway width where captured.
 *
 * @param {object} opts
 * @param {string} opts.buildingName
 * @param {Array<{ doorWidth: number, rampAngle: number, doorHeight?: number, pathwayWidth?: number }>} opts.measurements
 * @param {number} opts.minDoorWidth
 * @param {number} opts.minSlopeRatio
 * @param {number} opts.minDoorHeight
 * @param {number} opts.minPathwayWidth
 * @param {"concise"|"standard"|"detailed"} [opts.verbosity]
 * @returns {string}
 */
function summarizeReport({
  buildingName,
  measurements,
  minDoorWidth,
  minSlopeRatio,
  minDoorHeight,
  minPathwayWidth,
  verbosity
}) {
  if (!Array.isArray(measurements) || measurements.length === 0) {
    return "Summary:\nNo building measurements are selected in this report.";
  }

  const latest = measurements[0];
  const latestDoorPass = evaluateDoor(latest.doorWidth, minDoorWidth);
  const latestRampPass = evaluateRamp(latest.rampAngle, minSlopeRatio);
  const latestDoorHeightPass = evaluateDoorHeight(latest.doorHeight, minDoorHeight);
  const latestPathwayPass = evaluatePathwayWidth(latest.pathwayWidth, minPathwayWidth);
  const latestIssues = [];
  if (!latestDoorPass) latestIssues.push("door width is below minimum");
  if (!latestRampPass) latestIssues.push("ramp is steeper than allowed");
  if (latestDoorHeightPass === false) latestIssues.push("door clear height is below minimum");
  if (latestPathwayPass === false) latestIssues.push("pathway width is below minimum");

  const failureCount = measurements.filter(
    (entry) => {
      const doorFail = !evaluateDoor(entry.doorWidth, minDoorWidth);
      const rampFail = !evaluateRamp(entry.rampAngle, minSlopeRatio);
      const doorHeightFail = evaluateDoorHeight(entry.doorHeight, minDoorHeight) === false;
      const pathwayFail = evaluatePathwayWidth(entry.pathwayWidth, minPathwayWidth) === false;
      return doorFail || rampFail || doorHeightFail || pathwayFail;
    }
  ).length;
  const failureRate = failureCount / measurements.length;

  const severity =
    failureRate === 0 ? "Low" : failureRate > 0.5 ? "High" : "Medium";

  if (latestIssues.length > 0) {
    const issueSentence = latestIssues.join("; ");
    const base = `Summary:
${issueSentence}. ${buildingName} fails ADA compliance.
Severity: ${severity} (${failureCount}/${measurements.length} recent measurements contain failures).`;
    if (verbosity === "detailed") {
      return `${base}
Recommended action: meet all configured thresholds (door width >= ${minDoorWidth} in, ramp ratio >= 1:${minSlopeRatio}, door height >= ${minDoorHeight} in, pathway width >= ${minPathwayWidth} in).`;
    }
    return base;
  }

  const passSummary = `Summary:
Ramp slope and door width pass ADA thresholds in the latest reading. ${buildingName} is currently compliant.
Severity: ${severity} (${failureCount}/${measurements.length} recent measurements contain failures).`;
  if (verbosity === "concise") {
    return "Summary: Latest reading passes ADA thresholds. Building currently compliant.";
  }
  if (verbosity === "detailed") {
    return `${passSummary}
Recommendation: continue periodic checks to maintain compliance over time.`;
  }
  return passSummary;
}

/**
 * Parse pasted JSON/CSV-like payloads from the Import tab into `{ doorWidth, rampAngle, ... }`.
 * Not on the main hardware→AI path; kept for manual data entry.
 */
function parseImportPayload(rawPayload) {
  const payload = rawPayload.trim();
  if (!payload) {
    throw new Error("Payload is empty.");
  }

  const normalize = (value) => String(value || "").toLowerCase().replace(/[\s-]/g, "_");
  const toNumber = (value, label) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      throw new Error(`${label} is missing or invalid.`);
    }
    return numeric;
  };

  const fromJsonObject = (obj) => {
    const entries = Object.entries(obj).reduce((acc, [key, value]) => {
      acc[normalize(key)] = value;
      return acc;
    }, {});

    const door = entries.door_width ?? entries.doorwidth ?? entries.door;
    const doorHeight = entries.door_height ?? entries.doorheight;
    const pathwayWidth = entries.pathway_width ?? entries.pathwaywidth ?? entries.path_width;
    const rampAngle = entries.ramp_angle ?? entries.rampangle ?? entries.angle ?? entries.theta;
    const rampSlopeRatio = entries.ramp_slope ?? entries.rampslope ?? entries.slope_ratio;

    const doorWidth = toNumber(door, "Door width");
    if (doorWidth <= 0) {
      throw new Error("Door width must be a positive number.");
    }

    const doorHeightInches = doorHeight != null ? toNumber(doorHeight, "Door height") : null;
    if (doorHeightInches != null && doorHeightInches <= 0) {
      throw new Error("Door height must be a positive number.");
    }

    const pathwayWidthInches = pathwayWidth != null ? toNumber(pathwayWidth, "Pathway width") : null;
    if (pathwayWidthInches != null && pathwayWidthInches <= 0) {
      throw new Error("Pathway width must be a positive number.");
    }

    if (rampAngle != null) {
      const angleDegrees = toNumber(rampAngle, "Ramp angle");
      if (angleDegrees <= 0 || angleDegrees >= 89.9) {
        throw new Error("Ramp angle must be between 0 and 89.9 degrees.");
      }
      return {
        doorWidth,
        rampAngle: angleDegrees,
        doorHeight: doorHeightInches,
        pathwayWidth: pathwayWidthInches,
        sourceFormat: "JSON",
        sourceType: "ramp_angle"
      };
    }

    if (rampSlopeRatio != null) {
      const ratio = toNumber(rampSlopeRatio, "Ramp slope");
      if (ratio <= 0) {
        throw new Error("Ramp slope must be a positive number.");
      }
      const angleDegrees = (Math.atan(1 / ratio) * 180) / Math.PI;
      return {
        doorWidth,
        rampAngle: angleDegrees,
        doorHeight: doorHeightInches,
        pathwayWidth: pathwayWidthInches,
        sourceFormat: "JSON",
        sourceType: "ramp_slope"
      };
    }

    throw new Error("Missing ramp value. Include ramp_angle or ramp_slope.");
  };

  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === "object") {
      return fromJsonObject(parsed);
    }
  } catch (_error) {
    // Fallback to CSV parsing below.
  }

  const csvParts = payload.split(",").map((part) => part.trim()).filter(Boolean);
  if (csvParts.length < 2) {
    throw new Error("CSV format must include at least two values.");
  }

  if (csvParts.some((part) => part.includes(":") || part.includes("="))) {
    const csvObject = {};
    csvParts.forEach((part) => {
      const [key, value] = part.split(/[:=]/).map((item) => item.trim());
      if (key && value != null) {
        csvObject[key] = value;
      }
    });
    return fromJsonObject(csvObject);
  }

  const rampSlope = toNumber(csvParts[0], "Ramp slope");
  const doorWidth = toNumber(csvParts[1], "Door width");
  if (rampSlope <= 0 || doorWidth <= 0) {
    throw new Error("CSV values must be positive numbers.");
  }
  const doorHeight = csvParts.length >= 3 ? toNumber(csvParts[2], "Door height") : null;
  if (doorHeight != null && doorHeight <= 0) {
    throw new Error("Door height must be a positive number.");
  }
  const pathwayWidth = csvParts.length >= 4 ? toNumber(csvParts[3], "Pathway width") : null;
  if (pathwayWidth != null && pathwayWidth <= 0) {
    throw new Error("Pathway width must be a positive number.");
  }
  const angleDegrees = (Math.atan(1 / rampSlope) * 180) / Math.PI;
  return {
    doorWidth,
    rampAngle: angleDegrees,
    doorHeight,
    pathwayWidth,
    sourceFormat: "CSV",
    sourceType: "ramp_slope"
  };
}

function formatImpactClass(impact) {
  if (impact === "critical" || impact === "serious") return "bad";
  if (impact === "moderate") return "warn";
  return "ok";
}

function formatCheckStatus(status) {
  const normalized = String(status || "unknown").toLowerCase();
  if (normalized === "failed_high_confidence") {
    return { label: "FAILED", className: "bad" };
  }
  if (normalized === "advisory") {
    return { label: "ADVISORY", className: "warn" };
  }
  if (normalized === "passed") {
    return { label: "PASSED", className: "ok" };
  }
  if (normalized === "incomplete") {
    return { label: "INCOMPLETE", className: "warn" };
  }
  if (normalized === "inapplicable") {
    return { label: "N/A", className: "ok" };
  }
  return { label: normalized.toUpperCase(), className: "warn" };
}

function humanizeRuleId(ruleId) {
  const text = String(ruleId || "").trim();
  if (!text) return "Unspecified check";
  return text
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildDetailedChecks(scanResult) {
  if (!scanResult) return [];
  const fromAllChecks = Array.isArray(scanResult.allChecks) ? scanResult.allChecks : [];
  if (fromAllChecks.length > 0) return fromAllChecks;

  const failed = (scanResult.failedChecks || []).map((item) => ({
    ...item,
    status: item.status || "failed_high_confidence"
  }));
  const advisory = (scanResult.advisoryChecks || []).map((item) => ({
    ...item,
    status: item.status || "advisory"
  }));
  const passed = (scanResult.passedChecks || []).map((item) => ({
    ...item,
    status: item.status || "passed"
  }));
  const incomplete = (scanResult.incompleteChecks || []).map((item) => ({
    ...item,
    status: item.status || "incomplete"
  }));
  const inapplicable = (scanResult.inapplicableChecks || []).map((item) => ({
    ...item,
    status: item.status || "inapplicable"
  }));

  return [...failed, ...advisory, ...passed, ...incomplete, ...inapplicable];
}

function generateWebsiteFallbackReport(scanResult) {
  const violations = scanResult?.violations || [];
  const counts = scanResult?.counts || {};
  const advisoryCount = Number(counts.advisory || 0);
  const suppressedCount = Number(counts.suppressed || 0);
  const criticalCount = violations.filter((item) => item.impact === "critical").length;
  const seriousCount = violations.filter((item) => item.impact === "serious").length;
  const topIssue = violations[0];
  const passedChecks = scanResult?.passedChecks || [];

  if (violations.length === 0) {
    return `Executive Summary:
This automated scan did not detect high-confidence accessibility violations on this page.

What Passed:
The page passed ${counts.passes || 0} automated checks, indicating strong baseline support for many accessibility rules.

What Failed:
No high-confidence failed checks were returned in this scan.${advisoryCount > 0 ? ` ${advisoryCount} advisory item(s) were identified for manual review.` : ""}

Why It Matters:
Passing automated checks reduces risk, but automation cannot validate every real-world user interaction.

Recommended Fixes:
Perform a quick manual keyboard and screen-reader walkthrough before final sign-off to confirm usability in practice.${suppressedCount > 0 ? ` ${suppressedCount} known noisy rule(s) were downgraded to advisory to reduce false positives.` : ""}`;
  }

  return `Executive Summary:
This page has ${counts.violations || 0} accessibility violations, including ${criticalCount} critical and ${seriousCount} serious issues.

What Passed:
The page passed ${counts.passes || 0} checks. Example passing rules include: ${passedChecks
    .slice(0, 3)
    .map((item) => item.help || item.id)
    .join("; ") || "standard document checks"}.

What Failed:
The most urgent issue is "${topIssue?.help || "Unspecified issue"}" with ${topIssue?.impact || "unknown"} impact. Additional failures indicate gaps in landmark structure and semantic clarity for assistive technology.

Why It Matters:
These failures can make it harder for screen-reader and keyboard users to understand page structure and reach primary content efficiently.

Recommended Fixes:
Resolve critical and serious issues first, then moderate issues. Re-scan after each fix cycle and confirm with manual keyboard and screen-reader testing.`;
}

function cleanAiReportText(text) {
  return String(text || "")
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, "\"")
    .replace(/^"+|"+$/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseWebsiteReportSections(reportText) {
  const source = cleanAiReportText(reportText);
  const sectionTitles = [
    "Executive Summary",
    "What Passed",
    "What Failed",
    "Why It Matters",
    "Recommended Fixes"
  ];

  const indices = sectionTitles
    .map((title) => ({ title, index: source.indexOf(`${title}:`) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index);

  if (indices.length === 0) {
    return sectionTitles.map((title, idx) => ({
      title,
      content: idx === 0 ? source : "Not provided."
    }));
  }

  return indices.map((current, idx) => {
    const start = current.index + current.title.length + 1;
    const end = idx + 1 < indices.length ? indices[idx + 1].index : source.length;
    const content = source.slice(start, end).trim();
    return { title: current.title, content: content || "Not provided." };
  });
}

/** Strip deprecated “Recent Measurements” blocks from older saved Firestore reports. */
function sanitizeLegacyReportText(reportText) {
  const text = String(reportText || "").replace(/Inspector:\s*Bilal Salman/gi, "Inspector: Inspector");
  if (!text.includes("Recent Measurements:")) return text;
  return text.replace(/\nRecent Measurements:\n[\s\S]*?\n\nNotes:/, "\nNotes:");
}

function stripBuildingMeasurementSection(reportText) {
  const text = String(reportText || "");
  if (!text.includes("Latest Measurement:")) return text;
  return text.replace(/\nLatest Measurement:[\s\S]*?\n\nSelected Website Cases:/, "\n\nSelected Website Cases:");
}

function sanitizeInspectorName(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "Inspector";
  if (normalized.toLowerCase() === "bilal salman") return "Inspector";
  return normalized;
}

export default function App() {
  const [activeMenu, setActiveMenu] = useState("Overview");
  const [authUser, setAuthUser] = useState(null);
  const [authChecking, setAuthChecking] = useState(true);

  const [buildingName, setBuildingName] = useState("City Hall");
  const [inspectorName, setInspectorName] = useState("Inspector");
  const [inspectionDate, setInspectionDate] = useState(getTodayIsoDate());
  const [minSlopeRatio, setMinSlopeRatio] = useState(12);
  const [minDoorWidth, setMinDoorWidth] = useState(32);
  const [minDoorHeight, setMinDoorHeight] = useState(80);
  const [minPathwayWidth, setMinPathwayWidth] = useState(36);
  const [doorWidth, setDoorWidth] = useState(29);
  const [rampAngle, setRampAngle] = useState(6.2);
  const [themeMode, setThemeMode] = useState("light");
  const [lastRefreshedAt, setLastRefreshedAt] = useState("Not refreshed yet");
  const [reportText, setReportText] = useState("");
  const [summaryText, setSummaryText] = useState("Import measurements to auto-generate a report and readable summary.");
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [reportNotes, setReportNotes] = useState(
    "Measurements taken during ADA Vision field test. Review ADA section 405.2 and door clearance standards before final submission."
  );
  const [compiledMeasurements, setCompiledMeasurements] = useState([]);
  const [logs, setLogs] = useState([]);
  const [importPayload, setImportPayload] = useState('{"ramp_slope": 1.09, "door_width": 29}');
  const [importError, setImportError] = useState("");
  const [importSuccess, setImportSuccess] = useState("");
  const [importedReadings, setImportedReadings] = useState([]);
  const [websiteUrl, setWebsiteUrl] = useState("https://example.com");
  const [websiteScanLoading, setWebsiteScanLoading] = useState(false);
  const [websiteScanError, setWebsiteScanError] = useState("");
  const [websiteScanResult, setWebsiteScanResult] = useState(null);
  const [websiteScanViewTab, setWebsiteScanViewTab] = useState("summary");
  const [websiteDetailedAiLoading, setWebsiteDetailedAiLoading] = useState(false);
  const [websiteDetailedAiText, setWebsiteDetailedAiText] = useState("");
  const [savedWebsiteInspections, setSavedWebsiteInspections] = useState([]);
  const [selectedInspectionId, setSelectedInspectionId] = useState("");
  const [selectedReportCaseIds, setSelectedReportCaseIds] = useState([]);
  const [loadingSavedInspections, setLoadingSavedInspections] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSaveMessage, setSettingsSaveMessage] = useState("");
  const [cloudStateReady, setCloudStateReady] = useState(false);
  const cloudStateLoadedRef = useRef(false);
  /** Dedupes Bluetooth ingest: same `reading.id` from `/api/sensors/latest` is applied once. */
  const lastSensorReadingIdRef = useRef(null);

  /**
   * Measurements fed into report + AI: prefer `logs` and `importedReadings` (includes BT bridge),
   * sorted newest-first, capped at 20; otherwise a single fallback from manual sliders.
   * @returns {Array<{ id: number, timestamp: string, doorWidth: number, rampAngle: number }>}
   */
  function buildReportMeasurements(options = {}) {
    const includeFallback = options.includeFallback ?? true;
    const sourceMeasurements = [
      ...logs.map((entry) => ({
        id: entry.id,
        timestamp: entry.timestamp,
        doorWidth: Number(entry.doorWidth),
        rampAngle: Number(entry.rampAngle),
        doorHeight: Number.isFinite(Number(entry.doorHeight)) ? Number(entry.doorHeight) : null,
        pathwayWidth: Number.isFinite(Number(entry.pathwayWidth)) ? Number(entry.pathwayWidth) : null
      })),
      ...importedReadings.map((entry) => ({
        id: entry.id,
        timestamp: entry.timestamp,
        doorWidth: Number(entry.doorWidth),
        rampAngle: Number(entry.rampAngle),
        doorHeight: Number.isFinite(Number(entry.doorHeight)) ? Number(entry.doorHeight) : null,
        pathwayWidth: Number.isFinite(Number(entry.pathwayWidth)) ? Number(entry.pathwayWidth) : null
      }))
    ]
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, 20);

    const fallbackMeasurement = {
      id: Date.now(),
      timestamp: new Date().toLocaleString(),
      doorWidth: Number(doorWidth),
      rampAngle: Number(rampAngle),
      doorHeight: null,
      pathwayWidth: null
    };

    if (sourceMeasurements.length > 0) return sourceMeasurements;
    return includeFallback ? [fallbackMeasurement] : [];
  }

  /** @param {Array<{ id: number, timestamp: string, doorWidth: number, rampAngle: number }>} measurements */
  function buildRawReport(measurements, options = {}) {
    const selectedCases = savedWebsiteInspections.filter((item) =>
      selectedReportCaseIds.includes(item.id)
    );
    const includeBuildingMeasurements = options.includeBuildingMeasurements ?? (measurements.length > 0);
    const includeBuildingThresholds =
      options.includeBuildingThresholds ??
      includeBuildingMeasurements;

    return generateRawReport({
      buildingName,
      inspectorName,
      inspectionDate,
      notes: reportNotes,
      measurements,
      selectedCases,
      includeBuildingMeasurements,
      includeBuildingThresholds,
      minDoorWidth,
      minSlopeRatio,
      minDoorHeight,
      minPathwayWidth
    });
  }
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

  useEffect(() => {
    const savedImports = sessionStorage.getItem("adaVisionImportedReadings");
    if (savedImports) {
      try {
        const parsed = JSON.parse(savedImports);
        if (Array.isArray(parsed)) {
          setImportedReadings(parsed);
        }
      } catch (error) {
        console.error("Unable to parse imported readings", error);
      }
    }
  }, []);

  useEffect(() => {
    sessionStorage.setItem("adaVisionImportedReadings", JSON.stringify(importedReadings));
  }, [importedReadings]);

  useEffect(() => {
    document.body.classList.toggle("theme-dark", themeMode === "dark");
    return () => document.body.classList.remove("theme-dark");
  }, [themeMode]);

  useEffect(() => {
    function syncInspectionDate() {
      const today = getTodayIsoDate();
      setInspectionDate((previous) => (previous === today ? previous : today));
    }

    syncInspectionDate();
    const intervalId = setInterval(syncInspectionDate, 60000);
    return () => clearInterval(intervalId);
  }, []);

  /**
   * Polls the backend for the latest Bluetooth-ingested sample (bridge → `/api/sensors/ingest`).
   * New readings become import rows and refresh the visible door/ramp fields for the report.
   */
  useEffect(() => {
    let cancelled = false;

    async function pollLatestSensorReading() {
      try {
        const response = await fetch("/api/sensors/latest", {
          cache: "no-store"
        });
        if (!response.ok) return;

        const payload = await response.json();
        const reading = payload?.reading;
        if (!reading || !reading.id) return;
        if (lastSensorReadingIdRef.current === reading.id) return;
        if (!Number.isFinite(Number(reading.rampAngle)) || !Number.isFinite(Number(reading.doorWidth))) return;

        lastSensorReadingIdRef.current = reading.id;
        if (cancelled) return;

        const rampAngleValue = Number(reading.rampAngle);
        const doorWidthValue = Number(reading.doorWidth);
        // Treat bridge data like an import row so it flows through the same report pipeline.
        const importedEntry = {
          id: Date.now(),
          timestamp: new Date(reading.receivedAt || Date.now()).toLocaleString(),
          format: "BT Bridge",
          sourceType: "ramp_angle",
          doorWidth: Number(doorWidthValue.toFixed(2)),
          rampAngle: Number(rampAngleValue.toFixed(2)),
          doorHeight: null,
          pathwayWidth: null,
          slopeRatio: Number(calculateSlopeRatio(rampAngleValue).toFixed(2))
        };

        setImportedReadings((prev) => [importedEntry, ...prev].slice(0, 30));
        setDoorWidth(importedEntry.doorWidth);
        setRampAngle(importedEntry.rampAngle);
        setLastRefreshedAt(importedEntry.timestamp);
      } catch (_error) {
        // No backend / CORS / network: keep UI usable with manual or cached values.
      }
    }

    pollLatestSensorReading();
    const intervalId = setInterval(pollLatestSensorReading, 2500);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    cloudStateLoadedRef.current = false;
    setCloudStateReady(false);

    if (!authUser?.uid) return;

    refreshSavedWebsiteInspections();
    loadPersistedDashboardState(authUser.uid);
  }, [authUser]);

  useEffect(() => {
    if (!authUser?.uid || !cloudStateReady) return;
    const timeoutId = setTimeout(() => {
      persistDashboardState();
    }, 700);
    return () => clearTimeout(timeoutId);
  }, [
    authUser?.uid,
    cloudStateReady,
    activeMenu,
    buildingName,
    inspectorName,
    inspectionDate,
    minSlopeRatio,
    minDoorWidth,
    minDoorHeight,
    minPathwayWidth,
    doorWidth,
    rampAngle,
    themeMode,
    lastRefreshedAt,
    reportText,
    summaryText,
    reportNotes,
    compiledMeasurements,
    logs,
    importedReadings,
    websiteUrl,
    selectedInspectionId
  ]);

  useEffect(() => {
    if (!settingsSaveMessage) return;
    setSettingsSaveMessage("");
  }, [buildingName, inspectorName, minSlopeRatio, minDoorWidth, minDoorHeight, minPathwayWidth, themeMode]);

  function normalizeNumber(value, fallbackValue) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallbackValue;
  }

  async function loadPersistedDashboardState(userId) {
    try {
      const stateRef = doc(db, "users", userId, "dashboardState", "current");
      const snapshot = await getDoc(stateRef);
      if (!snapshot.exists()) {
        return;
      }

      const data = snapshot.data() || {};
      if (typeof data.activeMenu === "string") {
        setActiveMenu(data.activeMenu === "Import" ? "Buildings" : data.activeMenu);
      }
      if (typeof data.buildingName === "string") setBuildingName(data.buildingName);
      if (typeof data.inspectorName === "string") {
        setInspectorName(sanitizeInspectorName(data.inspectorName));
      }
      setInspectionDate(getTodayIsoDate());

      setMinSlopeRatio(normalizeNumber(data.minSlopeRatio, 12));
      setMinDoorWidth(normalizeNumber(data.minDoorWidth, 32));
      setMinDoorHeight(normalizeNumber(data.minDoorHeight, 80));
      setMinPathwayWidth(normalizeNumber(data.minPathwayWidth, 36));
      setDoorWidth(normalizeNumber(data.doorWidth, 29));
      setRampAngle(normalizeNumber(data.rampAngle, 6.2));
      if (typeof data.themeMode === "string") setThemeMode(data.themeMode);
      if (typeof data.lastRefreshedAt === "string") setLastRefreshedAt(data.lastRefreshedAt);
      if (typeof data.reportText === "string") {
        setReportText(sanitizeLegacyReportText(data.reportText));
      }
      if (typeof data.summaryText === "string") setSummaryText(data.summaryText);
      if (typeof data.reportNotes === "string") setReportNotes(data.reportNotes);

      if (Array.isArray(data.compiledMeasurements)) {
        setCompiledMeasurements(data.compiledMeasurements.slice(0, 20));
      }
      if (Array.isArray(data.logs)) {
        setLogs(data.logs.slice(0, 50));
      }
      if (Array.isArray(data.importedReadings)) {
        setImportedReadings(data.importedReadings.slice(0, 30));
      }
      if (typeof data.websiteUrl === "string") setWebsiteUrl(data.websiteUrl);
      if (typeof data.selectedInspectionId === "string") {
        setSelectedInspectionId(data.selectedInspectionId);
      }
    } catch (error) {
      console.error("Unable to load dashboard state from Firestore", error);
    } finally {
      cloudStateLoadedRef.current = true;
      setCloudStateReady(true);
    }
  }

  async function persistDashboardState() {
    if (!authUser?.uid || !cloudStateLoadedRef.current) return false;
    try {
      const stateRef = doc(db, "users", authUser.uid, "dashboardState", "current");
      await setDoc(
        stateRef,
        {
          activeMenu,
          buildingName,
          inspectorName: sanitizeInspectorName(inspectorName),
          inspectionDate,
          minSlopeRatio,
          minDoorWidth,
          minDoorHeight,
          minPathwayWidth,
          doorWidth,
          rampAngle,
          themeMode,
          lastRefreshedAt,
          reportText: sanitizeLegacyReportText(reportText),
          summaryText,
          reportNotes,
          compiledMeasurements: compiledMeasurements.slice(0, 20),
          logs: logs.slice(0, 50),
          importedReadings: importedReadings.slice(0, 30),
          websiteUrl,
          selectedInspectionId,
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
      return true;
    } catch (error) {
      console.error("Unable to save dashboard state to Firestore", error);
      return false;
    }
  }

  async function handleSaveSettings() {
    if (!authUser?.uid) {
      setSettingsSaveMessage("Sign in required before saving settings.");
      return;
    }
    setSavingSettings(true);
    setSettingsSaveMessage("");
    const ok = await persistDashboardState();
    setSavingSettings(false);
    if (ok) {
      setSettingsSaveMessage("Settings saved.");
      return;
    }
    setSettingsSaveMessage("Unable to save settings. Check Firestore rules/connection.");
  }

  async function handleLogout() {
    await logout();
    window.location.href = "/login.html";
  }

  /**
   * AI summary path: prefers `compiledMeasurements` when set, else `buildReportMeasurements()`.
   * Sends `rawReport` + thresholds + latest numeric facts to `/api/ai/summary` via `generateAiSummary`.
   * On failure, appends deterministic `summarizeReport` output with an error notice.
   *
   * @param {string} [rawReportOverride]
   * @param {Array<{ id?: number, timestamp?: string, doorWidth: number, rampAngle: number, doorHeight?: number, pathwayWidth?: number }>} [measurementsOverride]
   */
  async function generateSummary(rawReportOverride, measurementsOverride) {
    const measurements =
      measurementsOverride ||
      (compiledMeasurements.length > 0 ? compiledMeasurements : buildReportMeasurements());

    const rawReport = rawReportOverride || reportText || buildRawReport(measurements);

    const fallbackSummary = summarizeReport({
      buildingName,
      measurements,
      minDoorWidth,
      minSlopeRatio,
      minDoorHeight,
      minPathwayWidth,
      verbosity: "standard"
    });

    if (!rawReport.trim()) {
      setSummaryText(fallbackSummary);
      return;
    }

    try {
      setSummaryLoading(true);
      const latestMeasurement = measurements[0] || {};
      const latestDoorWidth = Number(latestMeasurement.doorWidth);
      const latestRampAngle = Number(latestMeasurement.rampAngle);
      // Must match server-side interpretation of ramp rule (1:X from angle).
      const latestSlopeRatio = calculateSlopeRatio(latestRampAngle);
      const aiSummary = await generateAiSummary({
        rawReport,
        buildingName,
        verbosity: "standard",
        minDoorWidth,
        minSlopeRatio,
        minDoorHeight,
        minPathwayWidth,
        latestDoorWidth: Number.isFinite(latestDoorWidth) ? Number(latestDoorWidth.toFixed(2)) : null,
        latestRampAngle: Number.isFinite(latestRampAngle) ? Number(latestRampAngle.toFixed(2)) : null,
        latestSlopeRatio: Number.isFinite(latestSlopeRatio) ? Number(latestSlopeRatio.toFixed(2)) : null,
        latestDoorHeight: Number.isFinite(Number(latestMeasurement.doorHeight))
          ? Number(Number(latestMeasurement.doorHeight).toFixed(2))
          : null,
        latestPathwayWidth: Number.isFinite(Number(latestMeasurement.pathwayWidth))
          ? Number(Number(latestMeasurement.pathwayWidth).toFixed(2))
          : null
      });
      setSummaryText(aiSummary);
    } catch (error) {
      setSummaryText(`${fallbackSummary}\n\nAI fallback notice: ${error.message}`);
    } finally {
      setSummaryLoading(false);
    }
  }

  /** Snapshot current merged measurements into `compiledMeasurements` and refresh `reportText`. */
  function generateReportFromLatestData() {
    // Keep building/hardware data independent from website case selection.
    // When website cases are selected, generate website-only report content.
    const includeBuildingMeasurements = selectedReportCaseIds.length === 0;
    const measurements = includeBuildingMeasurements
      ? buildReportMeasurements({ includeFallback: false })
      : [];
    const rawReport = buildRawReport(measurements, {
      includeBuildingMeasurements,
      includeBuildingThresholds: includeBuildingMeasurements && (logs.length > 0 || importedReadings.length > 0)
    });
    setCompiledMeasurements(measurements);
    setReportText(rawReport);
    return { rawReport, measurements };
  }

  async function generateAiSummaryFromCurrentReport() {
    const { rawReport, measurements } = generateReportFromLatestData();
    await generateSummary(rawReport, measurements);
  }

  function toggleReportCaseSelection(caseId) {
    setSelectedReportCaseIds((prev) =>
      prev.includes(caseId) ? prev.filter((id) => id !== caseId) : [...prev, caseId]
    );
  }

  function selectAllReportCases() {
    setSelectedReportCaseIds(savedWebsiteInspections.map((item) => item.id));
  }

  function clearAllReportCases() {
    setSelectedReportCaseIds([]);
  }

  /** CSV export uses the same `evaluateDoor` / `evaluateRamp` columns as the on-screen thresholds. */
  function exportReportCsv() {
    const measurements =
      compiledMeasurements.length > 0
        ? compiledMeasurements
        : [
            {
              id: Date.now(),
              timestamp: new Date().toLocaleString(),
              doorWidth: Number(doorWidth),
              rampAngle: Number(rampAngle)
            }
          ];

    const header = "timestamp,door_width_in,door_height_in,pathway_width_in,ramp_angle_deg,slope_ratio,door_status,ramp_status,door_height_status,pathway_status,overall_status";
    const rows = measurements.map((entry) => {
      const csvDoorPass = evaluateDoor(entry.doorWidth, minDoorWidth);
      const csvRampPass = evaluateRamp(entry.rampAngle, minSlopeRatio);
      const csvDoorHeightPass = evaluateDoorHeight(entry.doorHeight, minDoorHeight);
      const csvPathwayPass = evaluatePathwayWidth(entry.pathwayWidth, minPathwayWidth);
      const csvSlope = calculateSlopeRatio(entry.rampAngle);
      const overall =
        csvDoorPass &&
        csvRampPass &&
        csvDoorHeightPass !== false &&
        csvPathwayPass !== false
          ? "PASS"
          : "FAIL";
      const doorHeightValue = Number(entry.doorHeight);
      const pathwayValue = Number(entry.pathwayWidth);
      const doorHeightLabel = Number.isFinite(doorHeightValue) ? doorHeightValue.toFixed(2) : "";
      const pathwayLabel = Number.isFinite(pathwayValue) ? pathwayValue.toFixed(2) : "";
      const doorHeightStatus =
        csvDoorHeightPass === null ? "N/A" : csvDoorHeightPass ? "PASS" : "FAIL";
      const pathwayStatus =
        csvPathwayPass === null ? "N/A" : csvPathwayPass ? "PASS" : "FAIL";
      return `"${entry.timestamp}",${Number(entry.doorWidth).toFixed(2)},${doorHeightLabel},${pathwayLabel},${Number(
        entry.rampAngle
      ).toFixed(2)},${csvSlope.toFixed(2)},${csvDoorPass ? "PASS" : "FAIL"},${csvRampPass ? "PASS" : "FAIL"},${doorHeightStatus},${pathwayStatus},${overall}`;
    });

    const csvContent = [header, ...rows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ada-vision-report-${Date.now()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function exportReportPdf() {
    const printableText = reportText || "Generate report first.";
    const popup = window.open("", "_blank", "width=900,height=700");
    if (!popup) return;

    popup.document.write(`<html><head><title>ADA Vision Report</title></head><body><pre>${printableText}</pre></body></html>`);
    popup.document.close();
    popup.focus();
    popup.print();
  }

  function importMeasurementPayload() {
    setImportError("");
    setImportSuccess("");

    try {
      const parsed = parseImportPayload(importPayload);
      const importedEntry = {
        id: Date.now(),
        timestamp: new Date().toLocaleString(),
        format: parsed.sourceFormat,
        sourceType: parsed.sourceType,
        doorWidth: Number(parsed.doorWidth.toFixed(2)),
        rampAngle: Number(parsed.rampAngle.toFixed(2)),
        doorHeight: Number.isFinite(Number(parsed.doorHeight)) ? Number(Number(parsed.doorHeight).toFixed(2)) : null,
        pathwayWidth: Number.isFinite(Number(parsed.pathwayWidth))
          ? Number(Number(parsed.pathwayWidth).toFixed(2))
          : null,
        slopeRatio: Number(calculateSlopeRatio(parsed.rampAngle).toFixed(2))
      };

      setImportedReadings((prev) => [importedEntry, ...prev].slice(0, 30));
      lastSensorReadingIdRef.current = null;
      setDoorWidth(importedEntry.doorWidth);
      setRampAngle(importedEntry.rampAngle);
      setLastRefreshedAt(importedEntry.timestamp);
      setImportSuccess(`Imported ${parsed.sourceFormat} payload successfully.`);
    } catch (error) {
      setImportError(error.message || "Unable to parse payload.");
    }
  }

  function useLatestImportedReading() {
    if (importedReadings.length === 0) {
      setImportError("No imported readings available yet.");
      setImportSuccess("");
      return;
    }

    const latest = importedReadings[0];
    setDoorWidth(latest.doorWidth);
    setRampAngle(latest.rampAngle);
    setLastRefreshedAt(new Date().toLocaleString());
    setImportError("");
    setImportSuccess("Latest imported reading applied.");
  }

  async function scanWebsiteAccessibility() {
    setWebsiteScanError("");
    setWebsiteScanResult(null);
    setWebsiteDetailedAiText("");

    if (!websiteUrl.trim()) {
      setWebsiteScanError("Please enter a website URL.");
      return;
    }

    try {
      setWebsiteScanLoading(true);
      const response = await fetch("/api/websites/scan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ url: websiteUrl.trim() })
      });

      const rawBody = await response.text();
      let payload = {};
      try {
        payload = rawBody ? JSON.parse(rawBody) : {};
      } catch (_error) {
        payload = {};
      }

      const contentType = response.headers.get("content-type") || "";
      const isJson = contentType.includes("application/json");

      if (!isJson && response.ok) {
        throw new Error(
          "Website scan API is unavailable for this deployment. Run locally with `npm run dev`, or point `/api` to your backend scanner service."
        );
      }

      if (!response.ok) {
        const bodySnippet = rawBody ? rawBody.slice(0, 140).replace(/\s+/g, " ").trim() : "";
        throw new Error(
          payload.details
            ? `${payload.error || "Website scan failed."} ${payload.details}`
            : payload.error ||
                (bodySnippet
                  ? `Website scan failed. ${bodySnippet}`
                  : "Website scan failed.")
        );
      }

      setWebsiteScanResult(payload);

      if (authUser?.uid) {
        try {
          const reportText = generateWebsiteFallbackReport(payload);
          const inspectionsRef = collection(db, "users", authUser.uid, "websiteInspections");
          const createdDoc = await addDoc(inspectionsRef, {
            url: payload.url || websiteUrl.trim(),
            scannedAt: payload.scannedAt || new Date().toISOString(),
            counts: payload.counts || {},
            violations: Array.isArray(payload.violations) ? payload.violations : [],
            failedChecks: Array.isArray(payload.failedChecks) ? payload.failedChecks : [],
            advisoryChecks: Array.isArray(payload.advisoryChecks) ? payload.advisoryChecks : [],
            passedChecks: Array.isArray(payload.passedChecks) ? payload.passedChecks : [],
            incompleteChecks: Array.isArray(payload.incompleteChecks) ? payload.incompleteChecks : [],
            inapplicableChecks: Array.isArray(payload.inapplicableChecks) ? payload.inapplicableChecks : [],
            allChecks: Array.isArray(payload.allChecks) ? payload.allChecks : [],
            reportText,
            createdAt: serverTimestamp()
          });

          const createdAtLabel = new Date().toLocaleString();
          setSavedWebsiteInspections((prev) => [
            {
              id: createdDoc.id,
              url: payload.url || websiteUrl.trim(),
              scannedAt: payload.scannedAt || new Date().toISOString(),
              counts: payload.counts || {},
              violations: Array.isArray(payload.violations) ? payload.violations : [],
              failedChecks: Array.isArray(payload.failedChecks) ? payload.failedChecks : [],
              advisoryChecks: Array.isArray(payload.advisoryChecks) ? payload.advisoryChecks : [],
              passedChecks: Array.isArray(payload.passedChecks) ? payload.passedChecks : [],
              incompleteChecks: Array.isArray(payload.incompleteChecks) ? payload.incompleteChecks : [],
              inapplicableChecks: Array.isArray(payload.inapplicableChecks) ? payload.inapplicableChecks : [],
              allChecks: Array.isArray(payload.allChecks) ? payload.allChecks : [],
              reportText,
              createdAtLabel
            },
            ...prev
          ].slice(0, 200));
          // Keep case selection fully manual from the Reports panel.
          // Scanning a website should save the case, but not auto-select it for report generation.
          setSelectedInspectionId(createdDoc.id);
        } catch (saveError) {
          console.error("Unable to auto-save website inspection", saveError);
          setWebsiteScanError("Scan completed, but auto-save failed. Check Firestore rules and connection.");
        }
      }
    } catch (error) {
      setWebsiteScanError(error.message || "Unable to scan website.");
    } finally {
      setWebsiteScanLoading(false);
    }
  }

  async function generateDetailedWebsiteAiExplanation() {
    if (!websiteScanResult) {
      setWebsiteScanError("Run a website scan first.");
      return;
    }

    const checks = buildDetailedChecks(websiteScanResult);
    if (checks.length === 0) {
      setWebsiteScanError("No detailed checks available for AI explanation.");
      return;
    }

    try {
      setWebsiteDetailedAiLoading(true);
      setWebsiteScanError("");
      const text = await generateAiWebsiteDetailedReport({
        url: websiteScanResult.url || websiteUrl,
        checks
      });
      setWebsiteDetailedAiText(text);
    } catch (error) {
      setWebsiteScanError(error.message || "Unable to generate detailed AI explanation.");
    } finally {
      setWebsiteDetailedAiLoading(false);
    }
  }

  async function refreshSavedWebsiteInspections() {
    if (!authUser?.uid) return;
    setLoadingSavedInspections(true);
    try {
      const inspectionsRef = collection(db, "users", authUser.uid, "websiteInspections");
      const inspectionsQuery = query(inspectionsRef, orderBy("createdAt", "desc"), limit(200));
      const snapshot = await getDocs(inspectionsQuery);
      const records = snapshot.docs.map((docSnapshot) => {
        const data = docSnapshot.data();
        const createdAtDate = data.createdAt?.toDate?.() || null;
        return {
          id: docSnapshot.id,
          ...data,
          createdAtLabel: createdAtDate
            ? createdAtDate.toLocaleString()
            : data.scannedAt
              ? new Date(data.scannedAt).toLocaleString()
              : "Unknown time"
        };
      });
      setSavedWebsiteInspections(records);
      setSelectedReportCaseIds((prev) => {
        const available = new Set(records.map((item) => item.id));
        // Keep only user-selected IDs that still exist.
        // Do not auto-select all cases by default.
        return prev.filter((id) => available.has(id));
      });
      if (records.length === 0) {
        setSelectedInspectionId("");
      } else if (!selectedInspectionId || !records.some((item) => item.id === selectedInspectionId)) {
        setSelectedInspectionId(records[0].id);
      }
    } catch (error) {
      console.error("Unable to refresh saved inspections", error);
    } finally {
      setLoadingSavedInspections(false);
    }
  }

  if (authChecking) {
    return <main className="auth-page">Checking session...</main>;
  }

  function classifyWebsiteRisk(item) {
    const counts = item?.counts || {};
    const violations = Number(counts.violations || 0);
    const advisory = Number(counts.advisory || 0);
    const failedChecks = Array.isArray(item?.failedChecks) ? item.failedChecks : [];
    const hasCritical = failedChecks.some(
      (check) => String(check?.impact || "").toLowerCase() === "critical"
    );
    const seriousCount = failedChecks.filter(
      (check) => String(check?.impact || "").toLowerCase() === "serious"
    ).length;

    if (hasCritical || violations >= 8 || seriousCount >= 2) return "high";
    if (violations >= 3 || seriousCount >= 1 || advisory >= 6) return "moderate";
    return "low";
  }

  const scannedCaseCount = savedWebsiteInspections.length;
  const lowRiskCases = savedWebsiteInspections
    .filter((item) => classifyWebsiteRisk(item) === "low")
    .sort((a, b) => (a.counts?.violations || 0) - (b.counts?.violations || 0));
  const moderateRiskCases = savedWebsiteInspections
    .filter((item) => classifyWebsiteRisk(item) === "moderate")
    .sort((a, b) => (b.counts?.violations || 0) - (a.counts?.violations || 0));
  const highRiskCases = savedWebsiteInspections
    .filter((item) => classifyWebsiteRisk(item) === "high")
    .sort((a, b) => (b.counts?.violations || 0) - (a.counts?.violations || 0));

  function classifyBuildingRisk(measurement) {
    const doorPass = evaluateDoor(measurement?.doorWidth, minDoorWidth);
    const rampPass = evaluateRamp(measurement?.rampAngle, minSlopeRatio);
    const doorHeightPass = evaluateDoorHeight(measurement?.doorHeight, minDoorHeight);
    const pathwayPass = evaluatePathwayWidth(measurement?.pathwayWidth, minPathwayWidth);
    const slopeRatio = calculateSlopeRatio(measurement?.rampAngle);
    const failCount = [doorPass === false, rampPass === false, doorHeightPass === false, pathwayPass === false]
      .filter(Boolean).length;

    if (failCount === 0) return "low";

    const severeSlope = Number.isFinite(slopeRatio) && slopeRatio < minSlopeRatio * 0.75;
    const severeDoor = Number(measurement?.doorWidth) < minDoorWidth - 2;
    const severeDoorHeight = doorHeightPass === false && Number(measurement?.doorHeight) < minDoorHeight - 2;
    const severePathway = pathwayPass === false && Number(measurement?.pathwayWidth) < minPathwayWidth - 2;
    if (failCount >= 2 || severeSlope || severeDoor || severeDoorHeight || severePathway) return "high";

    return "moderate";
  }

  const buildingMeasurementsForOverview = [...logs, ...importedReadings]
    .map((entry) => ({
      id: entry.id,
      timestamp: entry.timestamp || "Unknown time",
      doorWidth: Number(entry.doorWidth),
      rampAngle: Number(entry.rampAngle),
      doorHeight: Number.isFinite(Number(entry.doorHeight)) ? Number(entry.doorHeight) : null,
      pathwayWidth: Number.isFinite(Number(entry.pathwayWidth)) ? Number(entry.pathwayWidth) : null
    }))
    .filter((entry) => Number.isFinite(entry.doorWidth) && Number.isFinite(entry.rampAngle))
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, 30);
  const lowRiskBuildingCases = buildingMeasurementsForOverview
    .filter((entry) => classifyBuildingRisk(entry) === "low");
  const moderateRiskBuildingCases = buildingMeasurementsForOverview
    .filter((entry) => classifyBuildingRisk(entry) === "moderate");
  const highRiskBuildingCases = buildingMeasurementsForOverview
    .filter((entry) => classifyBuildingRisk(entry) === "high");

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <img
            className="sidebar-logo"
            src={themeMode === "dark" ? "/ada-vision-logo.png" : "/ada-vision-logo-light.png"}
            alt="ADA Vision logo"
          />
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
          <h1>ADA Vision - {activeMenu}</h1>
          <div className="actions">
            <span className="badge">{themeMode === "dark" ? "Dark" : "Light"}</span>
            <span className="badge">{authUser?.email || "Inspector"}</span>
            <button className="btn btn-outline" onClick={handleLogout}>
              Sign out
            </button>
          </div>
        </header>

        {activeMenu === "Overview" && (
          <section className="overview-home">
            <article className="panel home-hero">
              <h3>Choose what you want to check</h3>
              <p>
                ADA Vision keeps it simple. Pick one path below: physical accessibility checks for
                ramp and door measurements, or website accessibility checks for ADA-friendly web
                content.
              </p>
            </article>

            <div className="home-grid">
              <article className="home-card">
                <h4>Ramp and Door Check</h4>
                <p>Import sensor readings, review live measurements, and generate the ADA report.</p>
                <button className="btn btn-primary" onClick={() => setActiveMenu("Buildings")}>
                  Open Ramp and Door
                </button>
              </article>

              <article className="home-card">
                <h4>Website Accessibility Check</h4>
                <p>Scan a website URL and review clear violations and remediation guidance.</p>
                <button className="btn btn-primary" onClick={() => setActiveMenu("Websites")}>
                  Open Website Scanner
                </button>
              </article>
            </div>

            <section className="bottom-grid">
              <article className="panel">
                <h3>Case Summary Snapshot</h3>
                <p>
                  This overview highlights your website scan triage: what needs remediation first,
                  what is already passing, and where to focus next.
                </p>
                <div className="row" style={{ marginBottom: "8px" }}>
                  <span className="badge">Total scanned cases: {scannedCaseCount}</span>
                  <span className="badge">High risk: {highRiskCases.length}</span>
                  <span className="badge">Moderate risk: {moderateRiskCases.length}</span>
                  <span className="badge">Low risk: {lowRiskCases.length}</span>
                </div>
                <p className="stat-meta">
                  Risk levels use both volume and severity. A case with fewer issues can still be
                  high risk when critical findings are present.
                </p>
                <div className="row" style={{ marginTop: "10px" }}>
                  <button
                    className="btn btn-outline"
                    onClick={refreshSavedWebsiteInspections}
                    disabled={loadingSavedInspections}
                  >
                    {loadingSavedInspections ? "Refreshing Cases..." : "Refresh Case Rankings"}
                  </button>
                </div>
              </article>

              <article className="panel">
                <h3>Overview Narrative</h3>
                <p>
                  ADA Vision currently has {highRiskCases.length} high-risk case
                  {highRiskCases.length === 1 ? "" : "s"}, {moderateRiskCases.length} moderate-risk
                  case{moderateRiskCases.length === 1 ? "" : "s"}, and {lowRiskCases.length} low-risk
                  case{lowRiskCases.length === 1 ? "" : "s"}.
                </p>
                <p className="stat-meta">
                  High risk includes critical findings or high violation volume. Moderate risk
                  indicates notable issues. Low risk has smaller issue counts and no major severity.
                </p>
              </article>
            </section>

            <section className="settings-grid">
              <article className="panel">
                <h3>High Risk Cases</h3>
                <table className="log-table">
                  <thead>
                    <tr>
                      <th>Website</th>
                      <th>Violations</th>
                      <th>Advisory</th>
                      <th>Passes</th>
                      <th>Captured</th>
                    </tr>
                  </thead>
                  <tbody>
                    {highRiskCases.length === 0 ? (
                      <tr>
                        <td colSpan="5">No high-risk cases right now.</td>
                      </tr>
                    ) : (
                      highRiskCases.map((item) => (
                        <tr key={`failed-${item.id}`}>
                          <td>{item.url}</td>
                          <td className="bad">{item.counts?.violations || 0}</td>
                          <td>{item.counts?.advisory || 0}</td>
                          <td>{item.counts?.passes || 0}</td>
                          <td>{item.createdAtLabel}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </article>

              <article className="panel">
                <h3>Moderate Risk Cases</h3>
                <table className="log-table">
                  <thead>
                    <tr>
                      <th>Website</th>
                      <th>Violations</th>
                      <th>Advisory</th>
                      <th>Passes</th>
                      <th>Captured</th>
                    </tr>
                  </thead>
                  <tbody>
                    {moderateRiskCases.length === 0 ? (
                      <tr>
                        <td colSpan="5">No moderate-risk cases right now.</td>
                      </tr>
                    ) : (
                      moderateRiskCases.map((item) => (
                        <tr key={`moderate-${item.id}`}>
                          <td>{item.url}</td>
                          <td>{item.counts?.violations || 0}</td>
                          <td className="warn">{item.counts?.advisory || 0}</td>
                          <td>{item.counts?.passes || 0}</td>
                          <td>{item.createdAtLabel}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </article>

              <article className="panel">
                <h3>Low Risk Cases</h3>
                <table className="log-table">
                  <thead>
                    <tr>
                      <th>Website</th>
                      <th>Violations</th>
                      <th>Advisory</th>
                      <th>Passes</th>
                      <th>Captured</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lowRiskCases.length === 0 ? (
                      <tr>
                        <td colSpan="5">No low-risk cases yet.</td>
                      </tr>
                    ) : (
                      lowRiskCases.map((item) => (
                        <tr key={`low-${item.id}`}>
                          <td>{item.url}</td>
                          <td>{item.counts?.violations || 0}</td>
                          <td>{item.counts?.advisory || 0}</td>
                          <td className="ok">{item.counts?.passes || 0}</td>
                          <td>{item.createdAtLabel}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </article>
            </section>

            <section className="bottom-grid" style={{ marginTop: "10px" }}>
              <article className="panel">
                <h3>Building Risk Snapshot</h3>
                <p>
                  Physical checks are also triaged by risk from your imported/logged building measurements.
                </p>
                <div className="row" style={{ marginBottom: "8px" }}>
                  <span className="badge">Building checks: {buildingMeasurementsForOverview.length}</span>
                  <span className="badge">High risk: {highRiskBuildingCases.length}</span>
                  <span className="badge">Moderate risk: {moderateRiskBuildingCases.length}</span>
                  <span className="badge">Low risk: {lowRiskBuildingCases.length}</span>
                </div>
                <p className="stat-meta">
                  High risk means multiple failed thresholds or severe misses. Moderate risk means one
                  failed threshold. Low risk means all captured thresholds pass.
                </p>
              </article>
            </section>

            <section className="settings-grid">
              <article className="panel">
                <h3>High Risk Building Cases</h3>
                <table className="log-table">
                  <thead>
                    <tr>
                      <th>Timestamp</th>
                      <th>Door (in)</th>
                      <th>Ramp (1:X)</th>
                      <th>Door Height</th>
                      <th>Pathway</th>
                    </tr>
                  </thead>
                  <tbody>
                    {highRiskBuildingCases.length === 0 ? (
                      <tr>
                        <td colSpan="5">No high-risk building cases right now.</td>
                      </tr>
                    ) : (
                      highRiskBuildingCases.slice(0, 10).map((item) => (
                        <tr key={`building-high-${item.id}`}>
                          <td>{item.timestamp}</td>
                          <td className={evaluateDoor(item.doorWidth, minDoorWidth) ? "ok" : "bad"}>
                            {item.doorWidth.toFixed(1)}
                          </td>
                          <td className={evaluateRamp(item.rampAngle, minSlopeRatio) ? "ok" : "bad"}>
                            {calculateSlopeRatio(item.rampAngle).toFixed(2)}
                          </td>
                          <td className={evaluateDoorHeight(item.doorHeight, minDoorHeight) === false ? "bad" : ""}>
                            {Number.isFinite(item.doorHeight) ? `${item.doorHeight.toFixed(1)} in` : "N/A"}
                          </td>
                          <td className={evaluatePathwayWidth(item.pathwayWidth, minPathwayWidth) === false ? "bad" : ""}>
                            {Number.isFinite(item.pathwayWidth) ? `${item.pathwayWidth.toFixed(1)} in` : "N/A"}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </article>

              <article className="panel">
                <h3>Moderate Risk Building Cases</h3>
                <table className="log-table">
                  <thead>
                    <tr>
                      <th>Timestamp</th>
                      <th>Door (in)</th>
                      <th>Ramp (1:X)</th>
                      <th>Door Height</th>
                      <th>Pathway</th>
                    </tr>
                  </thead>
                  <tbody>
                    {moderateRiskBuildingCases.length === 0 ? (
                      <tr>
                        <td colSpan="5">No moderate-risk building cases right now.</td>
                      </tr>
                    ) : (
                      moderateRiskBuildingCases.slice(0, 10).map((item) => (
                        <tr key={`building-moderate-${item.id}`}>
                          <td>{item.timestamp}</td>
                          <td className={evaluateDoor(item.doorWidth, minDoorWidth) ? "ok" : "warn"}>
                            {item.doorWidth.toFixed(1)}
                          </td>
                          <td className={evaluateRamp(item.rampAngle, minSlopeRatio) ? "ok" : "warn"}>
                            {calculateSlopeRatio(item.rampAngle).toFixed(2)}
                          </td>
                          <td className={evaluateDoorHeight(item.doorHeight, minDoorHeight) === false ? "warn" : ""}>
                            {Number.isFinite(item.doorHeight) ? `${item.doorHeight.toFixed(1)} in` : "N/A"}
                          </td>
                          <td className={evaluatePathwayWidth(item.pathwayWidth, minPathwayWidth) === false ? "warn" : ""}>
                            {Number.isFinite(item.pathwayWidth) ? `${item.pathwayWidth.toFixed(1)} in` : "N/A"}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </article>

              <article className="panel">
                <h3>Low Risk Building Cases</h3>
                <table className="log-table">
                  <thead>
                    <tr>
                      <th>Timestamp</th>
                      <th>Door (in)</th>
                      <th>Ramp (1:X)</th>
                      <th>Door Height</th>
                      <th>Pathway</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lowRiskBuildingCases.length === 0 ? (
                      <tr>
                        <td colSpan="5">No low-risk building cases yet.</td>
                      </tr>
                    ) : (
                      lowRiskBuildingCases.slice(0, 10).map((item) => (
                        <tr key={`building-low-${item.id}`}>
                          <td>{item.timestamp}</td>
                          <td className="ok">{item.doorWidth.toFixed(1)}</td>
                          <td className="ok">{calculateSlopeRatio(item.rampAngle).toFixed(2)}</td>
                          <td>{Number.isFinite(item.doorHeight) ? `${item.doorHeight.toFixed(1)} in` : "N/A"}</td>
                          <td>{Number.isFinite(item.pathwayWidth) ? `${item.pathwayWidth.toFixed(1)} in` : "N/A"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </article>
            </section>
          </section>
        )}

        {activeMenu === "Reports" && (
          <section style={{ marginTop: "14px" }}>
            <article className="panel">
              <h3>Reports</h3>
              <p>
                Choose which website cases to include, then generate a detailed inspection report
                and optional AI summary.
              </p>

              <details className="settings-section case-picker" style={{ marginTop: "8px" }} open>
                <summary className="case-picker-summary">
                  Case Selection (Select All That Apply)
                  <span className="badge">
                    {selectedReportCaseIds.length} / {savedWebsiteInspections.length} selected
                  </span>
                </summary>
                <div className="case-picker-body">
                  <div className="row" style={{ marginBottom: "8px" }}>
                    <button className="btn btn-outline" onClick={selectAllReportCases}>
                      Select All
                    </button>
                    <button className="btn btn-outline" onClick={clearAllReportCases}>
                      Clear All
                    </button>
                  </div>
                  <div className="case-picker-list">
                    {savedWebsiteInspections.length === 0 ? (
                      <p className="stat-meta">No saved website cases yet. Run scans first.</p>
                    ) : (
                      savedWebsiteInspections.map((item) => (
                        <label key={`report-case-${item.id}`} className="report-case-option">
                          <input
                            type="checkbox"
                            checked={selectedReportCaseIds.includes(item.id)}
                            onChange={() => toggleReportCaseSelection(item.id)}
                          />
                          <span>
                            {item.url} ({item.counts?.violations || 0} violations, {item.counts?.passes || 0} passes)
                          </span>
                        </label>
                      ))
                    )}
                  </div>
                </div>
              </details>

              <div className="row" style={{ marginTop: "10px" }}>
                <button className="btn btn-primary" onClick={generateReportFromLatestData}>
                  Generate Report
                </button>
                <button
                  className="btn btn-primary"
                  onClick={generateAiSummaryFromCurrentReport}
                  disabled={summaryLoading}
                >
                  {summaryLoading ? "Generating AI Summary..." : "Generate AI Summary"}
                </button>
                <button className="btn btn-outline" onClick={exportReportPdf}>
                  Download PDF
                </button>
                <button className="btn btn-outline" onClick={exportReportCsv}>
                  Export CSV
                </button>
              </div>

              <h4 style={{ marginTop: "14px", marginBottom: "8px" }}>Generated Report</h4>
              <div className="summary-box">
                {(selectedReportCaseIds.length > 0
                  ? stripBuildingMeasurementSection(sanitizeLegacyReportText(reportText))
                  : sanitizeLegacyReportText(reportText)) || "Click Generate Report to build a detailed report."}
              </div>

              <h4 style={{ marginTop: "14px", marginBottom: "8px" }}>AI Summary</h4>
              <div className="summary-box">
                {summaryText || "Click Generate AI Summary after creating a report."}
              </div>
            </article>
          </section>
        )}

        {activeMenu === "Buildings" && (
          <section style={{ marginTop: "14px" }}>
            <article className="panel">
              <h3>Buildings</h3>
              <p>
                Receive raw Bluetooth payloads (JSON/CSV), validate values, and store imported
                readings for this session.
              </p>
              <div className="row">
                <textarea
                  value={importPayload}
                  onChange={(event) => setImportPayload(event.target.value)}
                  placeholder='Example: {"ramp_slope": 1.09, "door_width": 29, "door_height": 82, "pathway_width": 40}'
                />
              </div>
              {importError && (
                <p className="status-error" style={{ marginTop: "10px" }}>
                  {importError}
                </p>
              )}
              {importSuccess && (
                <p className="status-success" style={{ marginTop: "10px" }}>
                  {importSuccess}
                </p>
              )}
              <p className="stat-meta" style={{ marginTop: "10px" }}>
                Bluetooth is handled by the Python bridge script. This website reads data from the
                localhost bridge API only.
              </p>
              <div className="row">
                <button className="btn btn-primary" onClick={importMeasurementPayload}>
                  Parse & Save Reading
                </button>
                <button className="btn btn-outline" onClick={useLatestImportedReading}>
                  Use Latest Imported
                </button>
              </div>
            </article>

            <article className="panel" style={{ marginTop: "10px" }}>
              <h3>Recent Imported Readings</h3>
              <table className="log-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Format</th>
                    <th>Door</th>
                    <th>Ramp (deg)</th>
                    <th>Ramp Ratio (1:X)</th>
                    <th>Door Height</th>
                    <th>Pathway Width</th>
                  </tr>
                </thead>
                <tbody>
                  {importedReadings.length === 0 ? (
                    <tr>
                      <td colSpan="7">No imports yet. Paste payload and click Parse & Save Reading.</td>
                    </tr>
                  ) : (
                    importedReadings.slice(0, 8).map((reading) => (
                      <tr key={reading.id}>
                        <td>{reading.timestamp}</td>
                        <td>{reading.format}</td>
                        <td>{reading.doorWidth} in</td>
                        <td>{reading.rampAngle} deg</td>
                        <td>1:{reading.slopeRatio}</td>
                        <td>{Number.isFinite(Number(reading.doorHeight)) ? `${reading.doorHeight} in` : "N/A"}</td>
                        <td>
                          {Number.isFinite(Number(reading.pathwayWidth))
                            ? `${reading.pathwayWidth} in`
                            : "N/A"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </article>
          </section>
        )}

        {activeMenu === "Settings" && (
          <section style={{ marginTop: "14px" }}>
            <article className="panel">
              <h3>Settings</h3>
              <p>Set your project defaults once so every report uses clear, consistent values.</p>

              <div className="settings-grid">
                <section className="settings-section">
                  <h4>Inspection Profile</h4>
                  <p className="settings-helper">
                    Basic report identity fields shown in generated reports. Inspection date auto-updates
                    to today's date.
                  </p>
                  <div className="row">
                    <label className="input-label">
                      Building Name
                      <input
                        type="text"
                        value={buildingName}
                        onChange={(event) => setBuildingName(event.target.value)}
                        placeholder="e.g., City Hall"
                      />
                    </label>
                    <label className="input-label">
                      Inspector Name
                      <input
                        type="text"
                        value={inspectorName}
                        onChange={(event) => setInspectorName(sanitizeInspectorName(event.target.value))}
                        placeholder="e.g., Omar M."
                      />
                    </label>
                  </div>
                </section>

                <section className="settings-section">
                  <h4>ADA Thresholds</h4>
                  <p className="settings-helper">
                    Clear pass/fail rules used across reports and AI summaries.
                  </p>
                  <div className="row">
                    <label className="input-label">
                      Ramp Standard (1:X ratio)
                      <input
                        type="number"
                        min="1"
                        step="0.5"
                        value={minSlopeRatio}
                        onChange={(event) => setMinSlopeRatio(Number(event.target.value))}
                        placeholder="12"
                      />
                    </label>
                    <label className="input-label">
                      Minimum Door Width (inches)
                      <input
                        type="number"
                        min="1"
                        step="0.5"
                        value={minDoorWidth}
                        onChange={(event) => setMinDoorWidth(Number(event.target.value))}
                        placeholder="32"
                      />
                    </label>
                    <label className="input-label">
                      Minimum Door Height (inches)
                      <input
                        type="number"
                        min="1"
                        step="0.5"
                        value={minDoorHeight}
                        onChange={(event) => setMinDoorHeight(Number(event.target.value))}
                        placeholder="80"
                      />
                    </label>
                    <label className="input-label">
                      Minimum Pathway Width (inches)
                      <input
                        type="number"
                        min="1"
                        step="0.5"
                        value={minPathwayWidth}
                        onChange={(event) => setMinPathwayWidth(Number(event.target.value))}
                        placeholder="36"
                      />
                    </label>
                  </div>
                  <p className="stat-meta">
                    Ramp acceptance: pass when ratio is <strong>1:{minSlopeRatio}</strong> or flatter
                    (higher X is flatter). Fail if steeper than that. Door acceptance: pass when width
                    is <strong>{minDoorWidth} in</strong> or wider; fail if under that value. Door
                    height acceptance: pass when height is <strong>{minDoorHeight} in</strong> or
                    higher. Pathway acceptance: pass when clear width is{" "}
                    <strong>{minPathwayWidth} in</strong> or wider (ADA standard 36 in).
                  </p>
                </section>

                <section className="settings-section">
                  <h4>Appearance</h4>
                  <p className="settings-helper">Switch UI theme for your workspace and presentations.</p>
                  <div className="row">
                    <label className="input-label">
                      Theme
                      <select value={themeMode} onChange={(event) => setThemeMode(event.target.value)}>
                        <option value="light">Light</option>
                        <option value="dark">Dark</option>
                      </select>
                    </label>
                  </div>
                </section>
              </div>
              <div className="row" style={{ marginTop: "12px" }}>
                <button className="btn btn-primary" onClick={handleSaveSettings} disabled={savingSettings}>
                  {savingSettings ? "Saving Settings..." : "Save Settings"}
                </button>
                {settingsSaveMessage ? <span className="stat-meta">{settingsSaveMessage}</span> : null}
              </div>
            </article>
          </section>
        )}

        {activeMenu === "Websites" && (
          <section style={{ marginTop: "14px" }}>
            <article className="panel">
              <h3>Website Accessibility Scanner</h3>
              <p>Scan a URL and generate a presentation-ready accessibility report.</p>
              <div className="row">
                <input
                  type="url"
                  value={websiteUrl}
                  onChange={(event) => setWebsiteUrl(event.target.value)}
                  placeholder="https://example.com"
                />
                <button
                  className="btn btn-primary"
                  onClick={scanWebsiteAccessibility}
                  disabled={websiteScanLoading}
                >
                  {websiteScanLoading ? "Scanning..." : "Scan Website"}
                </button>
              </div>
              <div className="row" style={{ marginTop: "10px" }}>
                <button
                  className={`btn ${websiteScanViewTab === "summary" ? "btn-primary" : "btn-outline"}`}
                  onClick={() => setWebsiteScanViewTab("summary")}
                >
                  Summary
                </button>
                <button
                  className={`btn ${websiteScanViewTab === "detail" ? "btn-primary" : "btn-outline"}`}
                  onClick={() => setWebsiteScanViewTab("detail")}
                >
                  Detail Scan
                </button>
              </div>
              {websiteScanError && (
                <p className="status-error" style={{ marginTop: "10px" }}>
                  {websiteScanError}
                </p>
              )}
              {websiteScanResult && (
                <>
                  <div className="row" style={{ marginTop: "10px" }}>
                    <span className="badge">Violations: {websiteScanResult.counts?.violations ?? 0}</span>
                    <span className="badge">Passes: {websiteScanResult.counts?.passes ?? 0}</span>
                    <span className="badge">Advisory: {websiteScanResult.counts?.advisory ?? 0}</span>
                    <span className="badge">Incomplete: {websiteScanResult.counts?.incomplete ?? 0}</span>
                    <span className="badge">Inapplicable: {websiteScanResult.counts?.inapplicable ?? 0}</span>
                  </div>
                  <p className="stat-meta" style={{ marginTop: "8px" }}>
                    Pass/fail uses high-confidence WCAG A/AA issues. Advisory findings are informational.
                  </p>

                  {websiteScanViewTab === "summary" && (
                    <>
                      <div className="website-report-grid" style={{ marginTop: "10px" }}>
                        {parseWebsiteReportSections(generateWebsiteFallbackReport(websiteScanResult)).map((section) => (
                          <article key={section.title} className="report-card">
                            <h4>{section.title}</h4>
                            <p>{section.content}</p>
                          </article>
                        ))}
                      </div>
                      {(websiteScanResult.failedChecks || []).length > 0 &&
                        (websiteScanResult.passedChecks || []).length > 0 && (
                          <div className="website-checks-grid" style={{ marginTop: "10px" }}>
                            <article className="panel">
                              <h3>Top Failed Checks</h3>
                              <ul className="checks-list">
                                {websiteScanResult.failedChecks.slice(0, 5).map((item) => (
                                  <li key={`fail-${item.id}`}>
                                    <span className={`metric-result ${formatImpactClass(item.impact)}`}>
                                      {String(item.impact || "unknown").toUpperCase()}
                                    </span>{" "}
                                    {item.help}
                                  </li>
                                ))}
                              </ul>
                            </article>
                            <article className="panel">
                              <h3>Top Passed Checks</h3>
                              <ul className="checks-list">
                                {websiteScanResult.passedChecks.slice(0, 5).map((item) => (
                                  <li key={`pass-${item.id}`}>
                                    <span className="metric-result ok">PASSED</span> {item.help}
                                  </li>
                                ))}
                              </ul>
                            </article>
                          </div>
                        )}
                    </>
                  )}

                  {websiteScanViewTab === "detail" && (
                    <div style={{ marginTop: "10px" }}>
                      {(() => {
                        const detailChecks = buildDetailedChecks(websiteScanResult);
                        return (
                          <>
                      <article className="panel">
                        <h3>Detailed Scan - Every Test</h3>
                        <p>
                          Total tests in this scan:{" "}
                          <strong>{detailChecks.length}</strong>
                        </p>
                        <table className="log-table">
                          <thead>
                            <tr>
                              <th>Accessibility Check</th>
                              <th>Status</th>
                              <th>Impact</th>
                              <th>Affected</th>
                              <th>Technical Rule ID</th>
                            </tr>
                          </thead>
                          <tbody>
                            {detailChecks.length === 0 ? (
                              <tr>
                                <td colSpan="5">No detailed checks returned.</td>
                              </tr>
                            ) : (
                              detailChecks.map((item) => {
                                const statusUi = formatCheckStatus(item.status);
                                return (
                                  <tr key={`${item.status}-${item.id}-${item.help}`}>
                                    <td>{humanizeRuleId(item.id)}</td>
                                    <td>
                                      <span className={`metric-result ${statusUi.className}`}>
                                        {statusUi.label}
                                      </span>
                                    </td>
                                    <td>{String(item.impact || "none").toUpperCase()}</td>
                                    <td>{item.affectedElements ?? 0}</td>
                                    <td>{item.id}</td>
                                  </tr>
                                );
                              })
                            )}
                          </tbody>
                        </table>
                      </article>

                      <article className="panel" style={{ marginTop: "10px" }}>
                        <h3>AI Detailed Explanation (All Tests)</h3>
                        <p>
                          Generates one explanation line for each test from this scan.
                        </p>
                        <div className="row" style={{ marginBottom: "10px" }}>
                          <button
                            className="btn btn-primary"
                            onClick={generateDetailedWebsiteAiExplanation}
                            disabled={websiteDetailedAiLoading}
                          >
                            {websiteDetailedAiLoading
                              ? "Generating Detailed AI Explanation..."
                              : "Generate AI Explanation for All Tests"}
                          </button>
                        </div>
                        <div className="summary-box">
                          {websiteDetailedAiText || "No AI detailed explanation generated yet."}
                        </div>
                      </article>
                          </>
                        );
                      })()}
                    </div>
                  )}
                </>
              )}
            </article>
          </section>
        )}
      </main>
    </div>
  );
}
