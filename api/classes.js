// Vercel 伺服器端程式：查某一天台北+新北的 BODYCOMBAT 課表
// 用法：/api/classes?date=2026-11-25
// 同時查兩個來源再合併：
//   1. 萵苣查查課（wgclass.vercel.app，資料來自 World Gym App，較完整、有代課標記）
//   2. wgc.pages.dev（備用，補第 1 個沒有的課）
const WGCLASS = 'https://wgclass.vercel.app/api/worldgym/search';
const WGC = 'https://wgc.sytes.net/api/Course';
const REGIONS = ['台北市', '新北市'];
const WGC_CITY_IDS = [1, 2]; // wgc 的 1 = 台北, 2 = 新北
const isCombat = name => name.replace(/[\s®]/g, '').toUpperCase() === 'BODYCOMBAT';

async function getJson(url, opts = {}, ms = 8500) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), ...opts });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 120)}`);
  return JSON.parse(t);
}

const hhmm = d => d.toISOString().slice(11, 16);

// 來源 1：萵苣查查課
async function fromWgclass(date, ms = 8500) {
  const j = await getJson(WGCLASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, regions: REGIONS, branches: [] }),
  }, ms);
  if (!Array.isArray(j.rows)) throw new Error('格式不對');
  return j.rows.filter(x => isCombat(x.class_name || '')).map(x => {
    const start = new Date(new Date(x.starts_at).getTime() + 8 * 3600e3); // 轉台灣時間
    const end = new Date(start.getTime() + (x.duration_minutes || 60) * 60e3);
    return {
      d: start.toISOString().slice(0, 10), s: hhmm(start), e: hhmm(end),
      store: (x.branches?.display_name || '').trim(),
      teacher: (x.instructors?.display_name || '').trim(),
      sub: !!x.substitute_instructor,
    };
  }).filter(c => c.d === date);
}

// 來源 2：wgc.pages.dev
async function fromWgc(date) {
  const headers = { 'Content-Type': 'application/json', Origin: 'https://wgc.pages.dev', Referer: 'https://wgc.pages.dev/' };
  const [stores, classes] = await Promise.all([getJson(WGC + '/store', { headers }), getJson(WGC + '/class', { headers })]);
  const storeIds = stores.filter(s => WGC_CITY_IDS.includes(s.cityId)).map(s => s.id);
  const classIds = classes.filter(c => isCombat(c.name)).map(c => c.id);
  const rows = await getJson(WGC + '/queryClass', {
    method: 'POST', headers,
    body: JSON.stringify({
      isDayOfWeek: false, startDate: date, endDate: date, dayOfWeeks: [], shift: 0,
      startTime: '00:00:00', endTime: '23:59:00', storeIds, isRoom: false, classIds,
      classRoom: -1, instructors: [], classType: 0,
    }),
  });
  return rows.map(x => ({
    d: x.classDate, s: x.startTime.slice(0, 5), e: x.endTime.slice(0, 5),
    store: x.storeName.trim(), teacher: x.instructor.trim(), sub: !!x.isSubstituted,
  }));
}

// 查某一天，合併兩個來源
async function fetchDay(date, ms) {
  const [a, b] = await Promise.allSettled([fromWgclass(date, ms), fromWgc(date)]);
  const main = a.status === 'fulfilled' ? a.value : [];
  const backup = b.status === 'fulfilled' ? b.value : [];
  if (a.status === 'rejected' && b.status === 'rejected')
    throw new Error(`兩個來源都失敗：${a.reason?.message}／${b.reason?.message}`);
  // 合併：同一天、同時間、同分店視為同一堂，以來源 1 為準
  const key = c => `${c.d} ${c.s} ${c.store}`;
  const seen = new Set(main.map(key));
  const classes = [...main, ...backup.filter(c => !seen.has(key(c)))]
    .sort((x, y) => (x.s + x.store).localeCompare(y.s + y.store));
  return { classes, sources: { app: a.status === 'fulfilled', wgc: b.status === 'fulfilled' } };
}

const shift = (date, n) => new Date(new Date(date + 'T00:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);

module.exports = async (req, res) => {
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '請帶 date=YYYY-MM-DD' });

  // 推測代課的原課老師：同分店、同星期幾、同時間的其他週次，沒有代課的老師就是原課老師
  // 資料來源不提供過去的日期，所以主要往後看（下週、下下週），上週還沒過才一起看
  const twToday = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const neighbors = [7, 14, -7].map(n => shift(date, n)).filter(d => d >= twToday);

  const [mainRes, ...nbRes] = await Promise.allSettled([fetchDay(date, 8500), ...neighbors.map(d => fetchDay(d, 7500))]);
  if (mainRes.status === 'rejected') return res.status(502).json({ error: mainRes.reason.message });
  const { classes, sources } = mainRes.value;

  const slot = c => `${c.s} ${c.store}`;
  const nbMaps = nbRes.filter(r => r.status === 'fulfilled')
    .map(r => new Map(r.value.classes.map(c => [slot(c), c])));
  for (const c of classes) {
    if (!c.sub) continue;
    for (const m of nbMaps) {
      const o = m.get(slot(c));
      if (o && !o.sub && o.teacher && o.teacher !== c.teacher) { c.orig = o.teacher; break; }
    }
  }

  // 結果暫存 10 分鐘，短時間內重複查不會一直去吵別人的伺服器
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
  res.status(200).json({ date, updated: new Date().toISOString(), sources, classes });
};
