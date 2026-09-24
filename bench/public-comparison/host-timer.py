"""Monotonic host wall timer. Contains no browser actions or task solution."""
import datetime
import json
from pathlib import Path
import sys
import time

mode, name = sys.argv[1:3]
assert mode in ('start', 'end')
assert name in ('b1-native', 'b1-jev', 'b2-jev', 'b2-native', 'b3-native', 'b3-jev')
path = Path(__file__).parent / (name + '-host.json')
if mode == 'start':
    if path.exists(): raise RuntimeError('Refusing to overwrite a recorded attempt')
    record = {'name': name, 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'startMonotonicNs': time.monotonic_ns()}
else:
    ended = time.monotonic_ns()
    record = json.loads(path.read_text())
    if 'endMonotonicNs' in record: raise RuntimeError('Attempt already finished')
    record.update({'endedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'endMonotonicNs': ended, 'hostWallMs': (ended-record['startMonotonicNs'])/1e6})
    record.update(json.loads(sys.argv[3]))
path.write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps(record))
