"""Plot public regression measurements; no model-generated numbers or private logs."""
import json
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Rectangle

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / "docs/benchmarks/2026-09-24-autocomplete"
data = json.loads((REPORT / "measurements.json").read_text())
run = data["formalSamples"][1]
bg, card, ink, muted, green = "#0C1521", "#182638", "#F3F5F7", "#A5B6CA", "#50E3BD"
plt.rcParams.update({"font.family": "DejaVu Sans"})
fig = plt.figure(figsize=(16, 10), facecolor=bg)
ax = fig.add_axes([0, 0, 1, 1]); ax.set_xlim(0, 1); ax.set_ylim(0, 1); ax.axis("off")
def text(x, y, value, size=16, color=ink, weight="normal", **kw):
    ax.text(x, y, value, fontsize=size, color=color, weight=weight, va="center", **kw)
def panel(x, y, w, h):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.012,rounding_size=0.012", facecolor=card, linewidth=0))

text(.05, .95, "JEV BROWSER USE", 15, green, "bold")
text(.95, .95, "LIVE REGRESSION  /  24 SEP 2026", 12, muted, ha="right")
text(.05, .882, "Correct station. Verified journey.", 31, weight="bold")
text(.05, .835, "12306 rail search  /  Real Chrome extension  /  Independent result verification", 16, muted)

stats = [(f'{run["elapsedMs"]/1000:.3f}s', "ACTIVE QUERY RUN"),
         (str(run["apiRequests"]), "JEV API REQUESTS"),
         ("0", "HOST HANDOFFS"),
         (str(data["validation"]["coreTests"]), "REGRESSION TESTS PASSED")]
for i, (value, label) in enumerate(stats):
    x = .05 + i * .233
    panel(x, .646, .208, .131)
    text(x+.018, .724, value, 36, green if i==0 else ink, "bold")
    text(x+.018, .67, label, 11, muted, "bold")

panel(.05, .443, .435, .153); panel(.516, .443, .431, .153)
text(.07, .565, "BEFORE  /  EXISTING STATION VALUES", 11, muted, "bold")
text(.07, .52, "Beijing  →  Shanghai", 23, weight="bold")
text(.07, .477, "Station codes: BJP  →  SHH", 14, muted)
text(.536, .565, "AFTER  /  CANDIDATES SELECTED", 11, green, "bold")
text(.536, .52, "Nanjing  →  Lhasa", 23, weight="bold")
text(.536, .477, "Station codes: NJH  →  LSO", 14, green)
text(.05, .393, "VERIFIED RESULT", 11, green, "bold")
text(.247, .393, "Z164  ·  01 Oct 2026  ·  42 h 17 m  ·  Query clicked once", 17, weight="bold")

text(.05, .325, "WHERE THE 4.442 SECONDS WENT", 12, muted, "bold")
t=run["timing"]
phases=[("Model requests",t["decisionMs"],"#50E3BD"),("UI settling",t["settleMs"],"#649AF5"),
        ("Observation",t["observeMs"],"#F1B96B"),("Preflight",t["preflightMs"],"#AD99E5"),
        ("Actions",t["actionMs"],"#F28F95"),("Other overhead",run["elapsedMs"]-sum(t[k]for k in ["decisionMs","settleMs","observeMs","preflightMs","actionMs"]),"#8C9BAB")]
left=.05
for _,value,color in phases:
    width=.897*value/run["elapsedMs"]; ax.add_patch(Rectangle((left,.267),width,.032,color=color,lw=0));left+=width
for i,(label,value,color) in enumerate(phases):
    x=.05+(i%3)*.311;y=.233-(i//3)*.035
    ax.add_patch(Rectangle((x,y-.004),.008,.008,color=color,lw=0))
    text(x+.015,y,f"{label}  {value/1000:.3f}s",12,muted)

text(.05,.141,"Date already set. Station-selection setup: 5.477s. Full CLI command incl. setup/navigation/screenshot: 10.963s.",12,muted)
text(.05,.109,"One observed query run. No booking made. This is a reliability check, not a Codex speed comparison.",12,muted)
text(.05,.063,"github.com/AuroraPixel/jev-browser-use",13,green)
text(.947,.063,"Measured data + scope in the linked report",11,muted,ha="right")
fig.savefig(REPORT / "report.png", dpi=120, facecolor=bg)
plt.close(fig)
