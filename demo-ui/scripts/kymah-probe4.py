# Inventory all trends in the flight payload: name, fit, stage, tags, sound.
import re, io, sys, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
s = open(r'C:\Users\Hi\AppData\Local\Temp\kymah.html', encoding='utf-8', errors='replace').read()
chunks = re.findall(r'self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)', s)
payload = ''.join(chunks).encode('utf-8').decode('unicode_escape').encode('latin-1', 'ignore').decode('utf-8', 'ignore')
i = payload.find('"trends":[{')
i = payload.find('[', i)
# balanced-bracket extraction
depth = 0
for j in range(i, len(payload)):
    c = payload[j]
    if c == '[': depth += 1
    elif c == ']':
        depth -= 1
        if depth == 0: break
arr = json.loads(payload[i:j+1])
print('trends:', len(arr))
for t in arr:
    fit = t.get('fit') or {}
    snd = t.get('sound') or {}
    cu = (snd.get('commercialUse') or {})
    print(f"- {t.get('name','?')[:58]:58s} | fit {fit.get('strength')} | {t.get('stage','?'):8s} | eng {t.get('eng')} | tags {len(t.get('tags') or [])} {str((t.get('tags') or [])[:3])[:40]} | sound: {str(snd.get('title'))[:22]} by {str(snd.get('author'))[:16]} cleared={cu.get('cleared')}")
print('\ncategories:', sorted(set((t.get('brief') or {}).get('category','?') for t in arr)))
