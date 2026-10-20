# Where do the sound/music mentions live? Embedded JSON? Detail pages?
import re, io, sys, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
s = open(r'C:\Users\Hi\AppData\Local\Temp\kymah.html', encoding='utf-8', errors='replace').read()
print('hrefs:', sorted(set(re.findall(r'href="(/[^"]*)"', s)))[:30])
print('NEXT_DATA:', '__NEXT_DATA__' in s, '| self.__next_f:', s.count('self.__next_f'))
# sample contexts of "sound" outside cards
idxs = [m.start() for m in re.finditer(r'sound', s)][:1505]
# find a context that looks like data (quoted/JSON)
shown = 0
for i in idxs:
    c = s[max(0, i-120):i+180]
    if '"' in c and ('hashtag' in c or 'Sound' in c or 'title' in c or '\\"' in c):
        print('----'); print(repr(c[:280])); shown += 1
    if shown >= 4: break
# look for a JSON array of trends
m = re.search(r'"hashtags?"\s*:', s)
print('json hashtags key:', bool(m))
if m: print(repr(s[m.start()-200:m.start()+400]))
