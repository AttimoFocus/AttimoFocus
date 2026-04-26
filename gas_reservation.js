// 【重要】事前に設定する変数
const CALENDAR_ID = '5eb47285e0e87f86071036a91d5ecc414b1d7f94cec1eb308da790777111974f@group.calendar.google.com'; // 予約を書き込む専用カレンダー
const PRIVATE_CALENDAR_ID = 'primary'; // プライベートの予定が入っているメインカレンダー（'primary'のままでOK）

// 【営業時間（予約枠）と前後の移動時間（パディング）の設定】
const START_HOUR = 7; // 予約受付開始時刻（7時）
const END_HOUR = 18;  // 予約受付終了時刻（18時）
const EVENT_DURATION_MINUTES = 60; // 実際の撮影時間（1時間：デフォルト値）
const PADDING_MINUTES = 60; // 前後の移動・準備時間（前後1時間ずつ：デフォルト値）

/**
 * 【プラン設定】各プランごとの撮影時間と確保時間（パディング）を設定します。
 * @param {string} planValue - プランの識別子
 * @returns {{duration: number, padding: number, titlePrefix: string}} 
 */
function getPlanSettings(planValue) {
  // 出張撮影・行事・ファミリー・1歳3回セット（前後1時間、合計3時間の確保が必要なプラン）
  if (planValue.includes("Birthday") ||
    planValue.includes("Family") ||
    planValue.includes("Events") ||
    planValue.includes("Shichigosan") ||
    planValue.includes("Tama1Year")) {
    return { duration: 60, padding: 60, titlePrefix: "【要3時間確保】" };
  }

  // 母の日特別撮影会プレミアムプラン（撮影1時間、パディングなしで計1時間枠）
  if (planValue.includes("MothersDay")) {
    return { duration: 60, padding: 0, titlePrefix: "【要1時間確保】" };
  }

  // 桜撮影プラン（30分のみの確保：15分撮影＋前後7.5分ずつ）
  if (planValue.includes("Sakura")) {
    return { duration: 15, padding: 7.5, titlePrefix: "【要30分確保】" };
  }

  // デフォルト（念のため。基本は上記に該当するようにします）
  return { duration: 60, padding: 60, titlePrefix: "【要3時間確保】" };
}

/**
 * 承認テスト用
 */
function testAuth() {
  let cal = CalendarApp.getDefaultCalendar();
  let sheet = SpreadsheetApp.getActiveSpreadsheet();
  console.log('承認が完了しました！');
}

/**
 * GETリクエスト：空き時間のリストを返します
 */
function doGet(e) {
  let requestDate = e.parameter.date;
  let requestPlan = e.parameter.plan || "";

  if (!requestDate) {
    return ContentService.createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 多摩1歳3回セット撮影プランの直接予約ブロック＆LINE誘導
  if (requestPlan.includes("Tama1Year")) {
    const callback = e.parameter.callback;
    const msg = ["※多摩1歳プランは公式LINEにて日程等のご相談・調整となります"];
    if (callback) {
      return ContentService.createTextOutput(callback + '(' + JSON.stringify(msg) + ');')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    } else {
      return ContentService.createTextOutput(JSON.stringify(msg))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // プランごとの期間制限チェック
  if (requestPlan.includes("Sakura")) {
    let reqDateObj = new Date(requestDate + 'T00:00:00+09:00');
    let deadlineDate = new Date('2026-04-10T23:59:59+09:00');
    if (reqDateObj > deadlineDate) {
      return ContentService.createTextOutput(JSON.stringify(["※桜プランは4月10日までの限定です"]))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  if (requestPlan.includes("MothersDay")) {
    let reqDateObj = new Date(requestDate + 'T00:00:00+09:00');
    let startDate = new Date('2026-05-01T00:00:00+09:00');
    let endDate = new Date('2026-05-05T23:59:59+09:00');
    if (reqDateObj < startDate || reqDateObj > endDate) {
      return ContentService.createTextOutput(JSON.stringify(["※母の日特別プランは5/1〜5/5限定です"]))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  let cal = CalendarApp.getCalendarById(CALENDAR_ID);
  let calPrivate = CalendarApp.getCalendarById(PRIVATE_CALENDAR_ID);

  if (!cal || !calPrivate) {
    return ContentService.createTextOutput(JSON.stringify(["カレンダーの接続エラー"]))
      .setMimeType(ContentService.MimeType.JSON);
  }

  let startTime = new Date(requestDate + 'T00:00:00+09:00');
  let endTime = new Date(requestDate + 'T23:59:59+09:00');

  // 両方のカレンダーから予定を取得してマージ
  let events = cal.getEvents(startTime, endTime).concat(calPrivate.getEvents(startTime, endTime));

  let availableSlots = [];
  let settings = getPlanSettings(requestPlan);
  let durationMin = settings.duration;
  let paddingMin = settings.padding;

  // 短時間プラン（桜）なら15分間隔、それ以外（母の日含む）は30分間隔でチェック
  let intervalMin = requestPlan.includes("Sakura") ? 15 : 30;

  for (let m = START_HOUR * 60; m <= END_HOUR * 60; m += intervalMin) {
    // 母の日プランの時間制限（10:00〜16:00）
    if (requestPlan.includes("MothersDay")) {
      if (m < 10 * 60 || m > 16 * 60) {
        continue;
      }
    }

    let hh = String(Math.floor(m / 60)).padStart(2, '0');
    let mm = String(m % 60).padStart(2, '0');
    let slotStart = new Date(requestDate + 'T' + hh + ':' + mm + ':00+09:00');

    // 拘束（ブロック）が必要な時間の範囲を計算
    let requiredStart = new Date(slotStart.getTime() - paddingMin * 60 * 1000);
    let requiredEnd = new Date(slotStart.getTime() + (durationMin + paddingMin) * 60 * 1000);

    let isBooked = false;

    // 既存の予定と重なりがないかチェック
    for (let i = 0; i < events.length; i++) {
      let evStart = events[i].getStartTime();
      let evEnd = events[i].getEndTime();

      // 重なり判定： (予定の開始 < 拘束の終了) かつ (予定の終了 > 拘束の開始)
      if (evStart < requiredEnd && evEnd > requiredStart) {
        isBooked = true;
        break;
      }
    }

    if (!isBooked) {
      availableSlots.push(hh + ':' + mm);
    }
  }

  // JSONP または JSON で返却
  let callback = e.parameter.callback;
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + JSON.stringify(availableSlots) + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  } else {
    return ContentService.createTextOutput(JSON.stringify(availableSlots))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * POSTリクエスト：予約フォームからの入力を受け取り、カレンダーに書き込みます
 */
function doPost(e) {
  let name = e.parameter.name || "お名前未設定";
  let email = e.parameter.email || "";
  let phone = e.parameter.phone || "";
  let plan = e.parameter.plan || "";
  let location = e.parameter.location || "";
  let date = e.parameter.date || "";
  let time = e.parameter.time || "";
  let notes = e.parameter.notes || "";
  let lineName = e.parameter.lineName || "未入力";

  let settings = getPlanSettings(plan);
  let durationMin = settings.duration;
  let paddingMin = settings.padding;

  let startTime = new Date(date + 'T' + time + ':00+09:00');
  let endTime = new Date(startTime.getTime() + (durationMin * 60 * 1000));

  // 拘束時間（移動時間含め）を計算
  let requiredStart = new Date(startTime.getTime() - paddingMin * 60 * 1000);
  let requiredEnd = new Date(startTime.getTime() + (durationMin + paddingMin) * 60 * 1000);

  let cal = CalendarApp.getCalendarById(CALENDAR_ID);
  let calPrivate = CalendarApp.getCalendarById(PRIVATE_CALENDAR_ID);

  // 母の日プランの時間制限バリデーション（念のため）
  if (plan.includes("MothersDay")) {
    let hh = parseInt(time.split(':')[0]);
    if (hh < 10 || hh > 16) {
      return HtmlService.createHtmlOutput('<div style="font-family:sans-serif; text-align:center; padding: 50px;"><b>エラー</b><br><br>母の日プランは10:00〜16:00の間のみ予約可能です。<br><br><button onclick="history.back()" style="padding: 10px 20px; background: #333; color: #fff; text-decoration: none; border-radius: 5px; border: none; cursor:pointer;">前の画面に戻る</button></div>');
    }
  }

  // 最終チェック：既に埋まっていないか再確認
  let events = cal.getEvents(requiredStart, requiredEnd).concat(calPrivate ? calPrivate.getEvents(requiredStart, requiredEnd) : []);

  if (events.length > 0) {
    return HtmlService.createHtmlOutput('<div style="font-family:sans-serif; text-align:center; padding: 50px;"><b>申しわけありません。</b><br><br>まさに今、その時間は別の予約で埋まってしまいました。<br><br><button onclick="history.back()" style="padding: 10px 20px; background: #333; color: #fff; text-decoration: none; border-radius: 5px; border: none; cursor:pointer;">前の画面に戻る</button></div>');
  } else {
    // カレンダーへ書き込み。撮影時間そのものではなく、前後1時間を含めた「ブロックが必要な全時間」でイベントを作成
    let displayEndTime = (paddingMin > 0) ? requiredEnd : endTime;
    let eventDesc = "【実際の撮影時間: " + time + " 〜 " + Utilities.formatDate(endTime, "JST", "HH:mm") + "】\n\n"
      + "プラン: " + plan + "\n場所: " + location + "\nLINE名: " + lineName + "\n電話番号: " + phone + "\nメール: " + email + "\n備考: " + notes;

    cal.createEvent(settings.titlePrefix + name + '様撮影：' + plan, requiredStart, displayEndTime, {
      description: eventDesc,
      location: location
    });

    // スプレッドシート（紐付いている場合）への記録
    try {
      let sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
      sheet.appendRow([new Date(), name, email, phone, plan, location, date, time, notes, lineName]);
    } catch (e) { }

    // LINEメッセージの生成
    let message = "【ご予約お申し込み】\n"
      + "■お名前：" + name + " 様\n"
      + "■LINE名：" + lineName + "\n"
      + "■希望日：" + date + "\n"
      + "■開始時間：" + time + "\n"
      + "■プラン：" + plan + "\n"
      + "■ロケーション：" + location + "\n"
      + "■電話番号：" + phone + "\n"
      + "■メール：" + email + "\n"
      + "■その他ご要望：\n" + (notes ? notes : "特になし") + "\n\n"
      + (plan.includes("MothersDay") ? "【ご案内】\n母の日特別撮影会等に関する事前の確認事項は、公式LINE上にてご案内申し上げます。\n\n" : "")
      + "※こちらのメッセージをそのまま送信してください。\n折り返しご案内差し上げます。";

    let encodedMessage = encodeURIComponent(message);
    let lineUrl = "https://line.me/R/oaMessage/@237ixiyp/?" + encodedMessage;

    // 予約完了後のHTML（サンスページ）
    let htmlTemplate = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ご予約受付</title>
  <style>
    body { font-family: 'Helvetica Neue', Arial, 'Hiragino Kaku Gothic ProN', 'Hiragino Sans', Meiryo, sans-serif; background-color: #f8f7f5; margin: 0; padding: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .container { background: #fff; padding: 40px 24px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); max-width: 400px; width: 90%; text-align: center; border: 1px solid #eee; }
    h1 { font-size: 22px; color: #333; margin-bottom: 24px; letter-spacing: 1px; }
    .highlight { display: inline-block; background: #f0fdf4; color: #166534; padding: 16px 24px; border-radius: 8px; font-weight: bold; margin-bottom: 24px; font-size: 15px; line-height: 1.6; border: 1px solid #bbf7d0; width: 85%; }
    p { font-size: 14px; color: #555; line-height: 1.7; margin-bottom: 28px; }
    .btn { display: block; width: 100%; box-sizing: border-box; padding: 16px 0; background: #06C755; color: #fff; text-decoration: none; border-radius: 50px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 12px rgba(6, 199, 85, 0.2); transition: 0.3s; }
    .warning { font-size: 12px; color: #ef4444; margin-top: 16px; font-weight: bold; margin-bottom: 0;}
  </style>
</head>
<body>
  <div class="container">
    <h1>仮予約を受け付けました！</h1>
    <div class="highlight">${date} ${time}〜<br>${plan}</div>
    <p><b>※ まだ予約は確定しておりません ※</b><br><br>引き続き、公式LINEを起動して<br><b>自動入力されたメッセージを送信</b>してください。<br>確認後、当方からの返信をもって【予約確定】となります。</p>
    <a href="${lineUrl}" target="_top" class="btn">公式LINEを開いて送信する</a>
    <p class="warning">※必ず上のボタンをタップしてLINEを起動してください</p>
  </div>
</body>
</html>`;

    return HtmlService.createHtmlOutput(htmlTemplate);
  }
}
