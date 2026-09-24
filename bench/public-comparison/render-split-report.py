"""Render the separated 24 September measurements; no browser or model calls."""
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / "docs/benchmarks/2026-09-24"
executor = json.loads((REPORT / "executor-summary.json").read_text())
workflow = json.loads((REPORT / "workflow-summary.json").read_text())
colors = ("#315BB5", "#148368")
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11})
fig = plt.figure(figsize=(15, 12), facecolor="#F7F9FC")
grid = fig.add_gridspec(2, 2, left=.16, right=.95, top=.80, bottom=.17, hspace=.64, wspace=.42)
tasks = ["selenium-form", "selenium-dynamic", "internet-controls", "internet-dynamic"]
labels = ["Selenium form", "Dynamic input", "Dropdown + checks", "Dynamic controls"]


def bars(ax, names, native, jev, limit):
    y = np.arange(len(names))
    for offset, values, color in [(-.19, native, colors[0]), (.19, jev, colors[1])]:
        ax.barh(y + offset, values, height=.32, color=color, zorder=3)
        for yi, value in zip(y + offset, values):
            ax.text(value + limit * .012, yi, f"{value:.3f}", va="center", fontsize=10)
    ax.set_yticks(y, names)
    ax.invert_yaxis()
    ax.set_xlim(0, limit)
    ax.set_xlabel("Seconds (lower is better)", fontsize=10)
    ax.set_facecolor("#F7F9FC")
    ax.grid(axis="x", color="#DDE3ED", zorder=0)
    ax.tick_params(length=0)
    for spine in ax.spines.values():
        spine.set_visible(False)


for col, key, title in [(0, "executionMs", "A1  Prepared execution + verification"),
                        (1, "workflowMs", "A2  Also include initial navigation")]:
    ax = fig.add_subplot(grid[0, col])
    medians = executor["medians"]
    bars(ax, labels, [medians["codex-browser-use"][t][key]/1000 for t in tasks],
         [medians["jev-local-plan"][t][key]/1000 for t in tasks], 16)
    ax.set_title(title, loc="left", fontsize=13, fontweight="bold", pad=19)

ax = fig.add_subplot(grid[1, :])
pair = workflow["pairs"]
bars(ax, [f"{p['task']}\nCalls {p['nativeBrowserToolCalls']} / {p['jevBrowserToolCalls']}" for p in pair],
     [p["nativeWallMs"]/1000 for p in pair], [p["jevWallMs"]/1000 for p in pair], 215)
ax.set_title("B  Task start to verified result: host planning, tools and recovery included",
             loc="left", fontsize=13, fontweight="bold", pad=19)

fig.text(.07, .952, "Separate the executor from the host workflow", fontsize=24, weight="bold", color="#16243C")
fig.text(.07, .918, "Selenium + The Internet  |  24 September 2026  |  All 46 measured workflows verified",
         fontsize=12, color="#4D5B70")
handles = [plt.Rectangle((0, 0), 1, 1, color=c) for c in colors]
fig.legend(handles, ["Codex built-in Browser Use", "Jev: A = local plans; B = hybrid delegation"],
           loc="upper left", bbox_to_anchor=(.065, .897), frameon=False, ncol=2, fontsize=11)
fig.text(.16, .850, "A: 5 trials/task/arm. 0 Jev API calls. Execution 1.34×; with navigation 1.02×.",
         fontsize=12, weight="bold", color="#16243C")
fig.text(.16, .482, "B: 1 attempt/task/arm. Same host context. Jev won 2 of 3 observed wall times.",
         fontsize=12, weight="bold", color="#16243C")
fig.text(.07, .078,
         "Different timing boundaries: do not pool A and B. A excludes host planning and dispatch; it does not measure Jev inference.\n"
         "B is exploratory, with shared context, order carryover and large out-of-tool timing variation. Not a model speed ranking.\n"
         "Profiles/viewports differ. Errors and recovery retained. Source: measured JSON and frozen protocol in the dated report.",
         fontsize=10.5, color="#4D5B70", linespacing=1.6)
fig.savefig(REPORT / "comparison.png", dpi=160, facecolor=fig.get_facecolor())
plt.close(fig)
print(REPORT / "comparison.png")
