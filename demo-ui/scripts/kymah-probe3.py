# Reassemble the Next.js flight payload and dump one full trend object.
import re, io, sys, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
s = open(r'C:\Users\Hi\AppData\Local\Temp\kymah.html', encoding='utf-8', errors='replace').read()
chunks = re.findall(r'self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)', s)
print('chunks:', len(chunks))
payload = ''.join(chunks)
# unescape the JS string
payload = payload.encode('utf-8').decode('unicode_escape').encode('latin-1', 'ignore').decode('utf-8', 'ignore')
print('payload len:', len(payload))
i = payload.find('"microTrend"')
print('microTrend at:', i)
# find the enclosing object: walk back to '{' balance-wise is hard; just show a window
start = payload.rfind('{"', max(0, i - 4000), i)
print(repr(payload[i-1200:i+2600]))
