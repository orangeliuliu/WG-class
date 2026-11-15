// 每小時由 GitHub Actions 執行：抓台北+新北的 BODYCOMBAT 課表，存成 data.json
import { writeFileSync } from 'node:fs';

const API = 'https://wgc.sytes.net/api/Course';
const DAYS = 21; // 往後抓幾天（WG 大約提供兩週多）
const CITY_IDS = [1, 2]; // 1 = 台北, 2 = 新北
const COURSE = 'BODYCOMBAT';

const headers = {
  'Content-Type': 'application/json',
  'Origin': 'https://wgc.pages.dev',
  'Referer': 'https://wgc.pages.dev/',
};

async function getJson(url, opts = {}) {
  const r = await fetch(url, { headers, ...opts });
  const t = await r.text();
  if (!r.ok) throw new Error(`${url} → ${r.status} ${t.slice(0, 200)}`);
  return JSON.parse(t);
}

const ymd = d => d.toISOString().slice(0, 10);

export async function build() {
  const [stores, classes] = await Promise.all([getJson(API + '/store'), getJson(API + '/class')]);
  const storeIds = stores.filter(s => CITY_IDS.includes(s.cityId)).map(s => s.id);
  const classIds = classes.filter(c => c.name.replace(/\s/g, '').toUpperCase() === COURSE).map(c => c.id);
  if (!storeIds.length || !classIds.length) throw new Error('找不到分店或課程代碼');

  // 以台灣時間的今天為起點，每次查 7 天（API 一次查太多天會回錯誤）
  const tw = new Date(Date.now() + 8 * 3600e3);
  const today = new Date(Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate()));
  const all = [];
  for (let i = 0; i < DAYS; i += 7) {
    const start = new Date(today.getTime() + i * 864e5);
    const end = new Date(today.getTime() + Math.min(i + 6, DAYS - 1) * 864e5);
    const rows = await getJson(API + '/queryClass', {
      method: 'POST',
      body: JSON.stringify({
        isDayOfWeek: false, startDate: ymd(start), endDate: ymd(end), dayOfWeeks: [], shift: 0,
        startTime: '00:00:00', endTime: '23:59:00', storeIds, isRoom: false, classIds,
        classRoom: -1, instructors: [], classType: 0,
      }),
    });
    all.push(...rows);
  }
  const list = all
    .map(x => ({
      d: x.classDate, s: x.startTime.slice(0, 5), e: x.endTime.slice(0, 5),
      store: x.storeName.trim(), teacher: x.instructor.trim(), sub: !!x.isSubstituted,
    }))
    .sort((a, b) => (a.d + a.s + a.store).localeCompare(b.d + b.s + b.store));
  return { updated: new Date().toISOString(), classes: list };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const data = await build();
  if (!data.classes.length) throw new Error('抓到 0 堂課，不更新 data.json');
  writeFileSync('data.json', JSON.stringify(data));
  console.log(`已更新 ${data.classes.length} 堂課`);
}
