"""Deterministic figure from all 60 measured trials; no image-generation data.
Run with Python + matplotlib==3.10.6 from the repository root.
"""
import json
import math
import statistics
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

root = Path(__file__).resolve().parents[2]
folder = root / 'docs/benchmarks/2026-09-23'
data = json.loads((folder / 'measured.json').read_text())
rows = data['rows']
arms = ['codex-computer-use', 'codex-browser-use', 'jev-browser-use']
names = ['Codex Computer Use', 'Codex Browser Use', 'jev-browser-use']
colors = ['#64748b', '#7864cf', '#028975']
tasks = ['selenium-form', 'selenium-dynamic', 'internet-controls', 'internet-dynamic']
titles = ['Selenium · web form', 'Selenium · dynamic input', 'The Internet · dropdown + checkboxes', 'The Internet · dynamic controls']
samples = {(a, t): [r['executionMs'] / 1000 for r in rows if r['arm'] == a and r['task'] == t] for a in arms for t in tasks}
assert len(rows) == 60 and all(r['verified'] for r in rows)
assert all(len(v) == 5 for v in samples.values())
medians = {k: statistics.median(v) for k, v in samples.items()}
ratios = {a: math.exp(statistics.mean(math.log(medians[a, t] / medians['jev-browser-use', t]) for t in tasks)) for a in arms[:2]}

plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 12, 'text.color': '#152536', 'axes.labelcolor': '#4c5c6b'})
fig = plt.figure(figsize=(15, 10.5), dpi=160, facecolor='#f4f7fb')
fig.text(.05, .953, 'REAL BROWSERS. THREE INTERFACES.', fontsize=24, weight='bold')
fig.text(.05, .919, 'Selenium + The Internet  /  23 Sep 2026  /  5 repetitions per workload and interface', fontsize=12, color='#506476')
cards = [(.05, '60 / 60', 'Independently verified trials', '#152536'),
         (.36, f'{ratios[arms[0]]:.2f}×', 'Jev speed ratio vs desktop Computer Use', '#028975'),
         (.67, f'{ratios[arms[1]]:.2f}×', 'Jev speed ratio vs built-in Browser Use', '#a34731')]
for x, value, label, color in cards:
    fig.patches.append(FancyBboxPatch((x, .808), .28, .08, boxstyle='round,pad=0.012,rounding_size=0.012', transform=fig.transFigure, facecolor='white', edgecolor='#dde5ef', zorder=0))
    fig.text(x+.012, .848, value, fontsize=24, weight='bold', color=color)
    fig.text(x+.012, .82, label, fontsize=9.5, color='#506476')
fig.text(.05, .761, 'Median prepared execution (seconds) · lower is better', fontsize=16, weight='bold')
fig.text(.05, .731, 'Dots show every measured trial. All panels share a zero-based 0–15 s scale.', fontsize=10.5, color='#506476')

grid = fig.add_gridspec(2, 2, left=.20, right=.95, bottom=.215, top=.69, hspace=.75, wspace=.73)
for i, task in enumerate(tasks):
    ax = fig.add_subplot(grid[i//2, i%2], facecolor='#f4f7fb')
    for j, arm in enumerate(arms):
        y = 2-j; median = medians[arm, task]
        ax.barh(y, median, height=.5, color=colors[j], alpha=.90, zorder=2)
        ax.scatter(samples[arm, task], [y]*5, s=17, facecolors='white', edgecolors=colors[j], linewidths=.9, zorder=3)
        ax.text(max(median, max(samples[arm, task]))+.17, y, f'{median:.2f}', va='center', fontsize=10.5, weight='bold', color=colors[j])
    ax.set_yticks([2,1,0], names, fontsize=10)
    ax.set_xlim(0,15); ax.set_ylim(-.7,2.7); ax.set_xticks([0,5,10,15]); ax.tick_params(axis='both', length=0, labelcolor='#506476', pad=8)
    ax.set_title(titles[i], fontsize=12, weight='bold', loc='left', pad=13)
    ax.grid(axis='x', color='#dbe3eb', lw=.7, zorder=0)
    for s in ax.spines.values(): s.set_visible(False)

fig.text(.05, .155, 'Result: faster than desktop Computer Use; slower than built-in Browser Use on all four execution medians.', fontsize=12, weight='bold')
fig.text(.05, .122, 'Speed ratios are geometric means of four workload median ratios. 1.00× means equal speed. No universal speed claim.', fontsize=10, color='#506476')
fig.text(.05, .096, 'Prepared programs only: host reasoning, authoring, outer tool dispatch and initial navigation excluded. Intermediate navigation included.', fontsize=9.3, color='#506476')
fig.text(.05, .074, 'Independent AX / DOM checks included. Dynamic controls contain ~12 s of site delay. One live semantic Jev target per workload.', fontsize=9.3, color='#506476')
fig.text(.05, .052, 'macOS arm64 · Chrome extension / desktop 1920×830 vs Codex in-app 1280×720 · Different profiles · Small local sample.', fontsize=9.3, color='#506476')
fig.text(.05, .022, 'Source: measured.json + reproducible harnesses in bench/public-comparison · Independent project, not an OpenAI or Jev vendor benchmark.', fontsize=9, color='#506476')
fig.savefig(folder / 'comparison.png', facecolor=fig.get_facecolor(), dpi=160)
plt.close(fig)
print(folder / 'comparison.png')
