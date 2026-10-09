'use strict';
require('sharp')(process.argv[2], { limitInputPixels: 50000000 }).png().toFile(process.argv[3]).catch(() => {
  console.error('無法轉換圖片。請將 HEIC 匯出為 PNG 或 JPEG 後再上傳。');
  process.exitCode = 1;
});
