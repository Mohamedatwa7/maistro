# Probe kymah.com markup: full card fields (hashtags? sounds/music? names?).
import re, io, sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
s = open(r'C:\Users\Hi\AppData\Local\Temp\kymah.html', encoding='utf-8', errors='replace').read()
blocks = s.split('<article class="lib__block">')[1:]
print('cards:', len(blocks))
names = [re.search(r'<h3 class="lib__name">([^<]+)</h3>', b) for b in blocks]
names = [n.group(1) if n else '???' for n in names]
brandok = ['brandok' in b for b in blocks]
for i, (n, ok) in enumerate(zip(names, brandok)):
    print(f'{i:2d} {"[FIT]" if ok else "     "} {n[:70]}')
# field inventory inside one samsung-fit card
fit_idx = brandok.index(True)
b = blocks[fit_idx]
print('\n==== classes in a fit card ====')
print(sorted(set(re.findall(r'class="([^"]+)"', b)))[:60])
print('\n==== hashtag-ish content ====')
print(re.findall(r'#[\w؀-ۿ]+', b)[:20])
print('\n==== sound/music snippets ====')
for m in re.finditer(r'.{80}(?:sound|Sound|music|Music|audio|Audio).{120}', b):
    print(repr(m.group(0)[:230])); print('---')
