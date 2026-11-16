// Vercel 伺服器端程式：有人打開網頁時才執行，即時去 WG 抓台北+新北的 BODYCOMBAT 課表
const API = 'https://wgc.sytes.net/api/Course';
const DAYS = 21;          // 往後抓幾天
const CITY_IDS = [1, 2];  // 1 = 台北, 2 = 新北
const COURSE = 'BODYCOMBAT';

const headers = { 'Content-Type': 'application/json', Origin: 'https://wgc.pages.dev', Referer: 'https://wgc.pages.dev/' };

async function getJson(url, opts = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000), ...opts });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 200)}`);
  return JSON.parse(t);
}
const ymd = d => d.toISOString().slice(0, 10);

module.exports = async (req, res) => {
  try {
    const [stores, classes] = await Promise.all([getJson(API + '/store'), getJson(API + '/class')]);
    const storeIds = stores.filter(s => CITY_IDS.includes(s.cityId)).map(s => s.id);
    const classIds = classes.filter(c => c.name.replace(/\s/g, '').toUpperCase() === COURSE).map(c => c.id);

    const tw = new Date(Date.now() + 8 * 3600e3);
    const today = new Date(Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate()));
    const ranges = [];
    for (let i = 0; i < DAYS; i += 7) ranges.push([i, Math.min(i + 6, DAYS - 1)]);
    // 三週分三次同時查（API 一次查太多天會回錯誤）
    const parts = await Promise.all(ranges.map(([a, b]) => getJson(API + '/queryClass', {
      method: 'POST',
      body: JSON.stringify({
        isDayOfWeek: false, startDate: ymd(new Date(today.getTime() + a * 864e5)), endDate: ymd(new Date(today.getTime() + b * 864e5)),
        dayOfWeeks: [], shift: 0, startTime: '00:00:00', endTime: '23:59:00', storeIds, isRoom: false, classIds,
        classRoom: -1, instructors: [], classType: 0,
      }),
    })));
    const list = parts.flat()
      .map(x => ({ d: x.classDate, s: x.startTime.slice(0, 5), e: x.endTime.slice(0, 5),
        store: x.storeName.trim(), teacher: x.instructor.trim(), sub: !!x.isSubstituted }))
      .sort((a, b) => (a.d + a.s + a.store).localeCompare(b.d + b.s + b.store));

    // 結果暫存 5 分鐘，短時間內重複打開不會一直去吵 WG
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    res.status(200).json({ updated: new Date().toISOString(), classes: list });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
};
