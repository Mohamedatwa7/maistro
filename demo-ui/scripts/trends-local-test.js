// Local harness for api/trends.js (no ANTHROPIC key → rules curation).
const handler = require('../api/trends.js');
const res = {
  headers: {}, code: 200,
  setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.code = c; return this; },
  json(d) {
    console.log('HTTP', this.code, '| curatedBy:', d.curatedBy, '| count:', d.count);
    if (d.error) { console.log('ERROR:', d.error); process.exit(1); }
    d.trends.forEach((t) => console.log(
      `- ${t.name.slice(0, 52).padEnd(52)} fit=${t.samsungFit.score} ${t.status} tags=[${t.tags.join(',')}] sound=${t.sound ? `"${t.sound.title}" cleared=${t.sound.cleared}` : '—'} clips=${t.clips.length}`));
    const t0 = d.trends[0];
    console.log('\nsample mechanic:', (t0.mechanic || '').slice(0, 140));
  },
};
handler({ query: {} }, res).catch((e) => { console.error(e); process.exit(1); });
