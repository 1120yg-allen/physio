// 建置模式。純本機版(GitHub Pages 等靜態空間)沒有後端伺服器:
// 資料只存在這個瀏覽器的 IndexedDB,沒有同步、LINE、Google 行事曆與伺服器端備份。
export const STATIC_MODE: boolean = import.meta.env.VITE_STATIC === '1';

export const STATIC_NOTICE = '純本機版:資料只存在這個瀏覽器,沒有伺服器備份。LINE、Google 行事曆與多裝置同步需要在自己的電腦執行伺服器(npm start)。';
