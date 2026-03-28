// 【重要】事前に設定する変数
const CALENDAR_ID = '5eb47285e0e87f86071036a91d5ecc414b1d7f94cec1eb308da790777111974f@group.calendar.google.com'; // 予約を書き込む専用カレンダー
const PRIVATE_CALENDAR_ID = 'primary'; // プライベートの予定が入っているメインカレンダー（'primary'のままでOK）

// 【営業時間（予約枠）と前後の移動時間（パディング）の設定】
const START_HOUR = 7; // 予約受付開始時刻（7時）
const END_HOUR = 18;  // 予約受付終了時刻（18時）
const EVENT_DURATION_MINUTES = 60; // 実際の撮影時間（1時間）
const PADDING_MINUTES = 60; // 前後の移動・準備時間（前後1時間ずつ）

function testAuth() {
  let cal = CalendarApp.getDefaultCalendar();
  let sheet = SpreadsheetApp.getActiveSpreadsheet();
  console.log('承認が完了しました！');
}

// 【新機能】日付を指定されたら、その日の「埋まっていない空き時間」をリストにして返す機能
function doGet(e) {
  let requestDate = e.parameter.date;
  let requestPlan = e.parameter.plan || "";

  if (!requestDate) {
    return ContentService.createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);
  }

  let isSakura = requestPlan.includes("Sakura");
  if (isSakura) {
    let reqDateObj = new Date(requestDate + 'T00:00:00+09:00');
    let deadlineDate = new Date('2026-04-10T23:59:59+09:00');
    if (reqDateObj > deadlineDate) {
      return ContentService.createTextOutput(JSON.stringify(["※桜プランは4月10日までの限定です"]))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  let cal = CalendarApp.getCalendarById(CALENDAR_ID);
  let calPrivate = CalendarApp.getCalendarById(PRIVATE_CALENDAR_ID);

  if (!cal || !calPrivate) {
    return ContentService.createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);
  }

  let startTime = new Date(requestDate + 'T00:00:00+09:00');
  let endTime = new Date(requestDate + 'T23:59:59+09:00');

  // 予約専用カレンダーと、プライベートカレンダーの両方の予定を取得
  let eventsMain = cal.getEvents(startTime, endTime);
  let eventsPrivate = calPrivate.getEvents(startTime, endTime);
  let events = eventsMain.concat(eventsPrivate);

  let availableSlots = [];

  let durationMin = isSakura ? 15 : EVENT_DURATION_MINUTES;
  let paddingMin = isSakura ? 0 : PADDING_MINUTES;
  let intervalMin = isSakura ? 15 : 30;

  // 7:00 から 18:00 まで計算
  for (let m = START_HOUR * 60; m <= END_HOUR * 60; m += intervalMin) {
    let hh = String(Math.floor(m / 60)).padStart(2, '0');
    let mm = String(m % 60).padStart(2, '0');
    let slotStart = new Date(requestDate + 'T' + hh + ':' + mm + ':00+09:00');

    // この枠に予約を入れた場合に必要な「拘束時間」
    let requiredStart = new Date(slotStart.getTime() - paddingMin * 60 * 1000);
    let requiredEnd = new Date(slotStart.getTime() + (durationMin + paddingMin) * 60 * 1000);

    let isBooked = false;

    // 予定と被っているかチェック
    for (let i = 0; i < events.length; i++) {
      let evStart = events[i].getStartTime();
      let evEnd = events[i].getEndTime();

      // 既存の予定が、この「必須の拘束時間（前1時間〜撮影〜後1時間）」に被っていないかチェック
      if (evStart < requiredEnd && evEnd > requiredStart) {
        isBooked = true;
        break;
      }
    }

    // 埋まっていなければ空き枠として追加
    if (!isBooked) {
      let timeStr = String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
      availableSlots.push(timeStr);
    }
  }

  // JSONPを利用してCORSを回避（動的ローディング対応）
  let callback = e.parameter.callback;
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + JSON.stringify(availableSlots) + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  } else {
    // 通常のJSON返却（フォールバック）
    let output = ContentService.createTextOutput(JSON.stringify(availableSlots))
      .setMimeType(ContentService.MimeType.JSON);
    return output;
  }
}

// 予約を受け取る機能
function doPost(e) {
  let name = e.parameter.name || "名称未設定";
  let email = e.parameter.email || "";
  let phone = e.parameter.phone || "";
  let plan = e.parameter.plan || "";
  let location = e.parameter.location || "";
  let date = e.parameter.date || "";
  let time = e.parameter.time || "";
  let notes = e.parameter.notes || "";
  let lineName = e.parameter.lineName || "未入力";

  let isSakura = plan.includes("Sakura");
  let durationMin = isSakura ? 15 : EVENT_DURATION_MINUTES;
  let paddingMin = isSakura ? 0 : PADDING_MINUTES;

  let startTime = new Date(date + 'T' + time + ':00+09:00');
  let endTime = new Date(startTime.getTime() + (durationMin * 60 * 1000));

  // 今すぐ予約を入れた場合に必要となる「前後の拘束時間」を含めた範囲で再チェック
  let requiredStart = new Date(startTime.getTime() - paddingMin * 60 * 1000);
  let requiredEnd = new Date(startTime.getTime() + (durationMin + paddingMin) * 60 * 1000);

  let cal = CalendarApp.getCalendarById(CALENDAR_ID);
  let calPrivate = CalendarApp.getCalendarById(PRIVATE_CALENDAR_ID);

  // 最終チェック：必須拘束時間が完全に空いているか
  let eventsMain = cal.getEvents(requiredStart, requiredEnd);
  let eventsPrivate = calPrivate ? calPrivate.getEvents(requiredStart, requiredEnd) : [];
  let events = eventsMain.concat(eventsPrivate);

  if (events.length > 0) {
    return HtmlService.createHtmlOutput('<div style="font-family:sans-serif; text-align:center; padding: 50px;"><b>申し訳ありません。</b><br><br>その時間は直前で別の予約が埋まってしまいました。<br><br><button onclick="history.back()" style="padding: 10px 20px; background: #333; color: #fff; text-decoration: none; border-radius: 5px; border: none; cursor:pointer;">前の画面に戻る</button></div>');
  } else {
    // カレンダーに予定を作成
    let eventDesc = "プラン: " + plan + "\n場所: " + location + "\nLINE名: " + lineName + "\n電話番号: " + phone + "\nメール: " + email + "\n備考: " + notes;
    cal.createEvent(name + '様撮影：' + plan, startTime, endTime, {
      description: eventDesc,
      location: location
    });

    // スプレッドシートへ記録 (LINEアカウント名は一番最後に追加)
    let sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    sheet.appendRow([new Date(), name, email, phone, plan, location, date, time, notes, lineName]);

    // LINEへのリダイレクトURLを作成
    let message = "【ご予約のお申し込み】\n"
      + "■お名前：" + name + " 様\n"
      + "■LINE名：" + lineName + "\n"
      + "■希望日：" + date + "\n"
      + "■開始時間：" + time + "\n"
      + "■プラン：" + plan + "\n"
      + "■ロケーション：" + location + "\n"
      + "■電話番号：" + phone + "\n"
      + "■メール：" + email + "\n"
      + "■その他ご要望：\n" + (notes ? notes : "なし") + "\n\n"
      + "※こちらのメッセージをそのまま送信してください。\n折り返しご案内差し上げます。";

    let encodedMessage = encodeURIComponent(message);
    let lineUrl = "https://line.me/R/oaMessage/@237ixiyp/?" + encodedMessage;

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
    <p><b>※ まだ予約は確定しておりません ※</b><br><br>引き続き、公式LINEを起動して<br><b>自動入力されたメッセージを送信</b>してください。<br>当方からのご返信をもって【予約確定】となります。</p>
    <a href="${lineUrl}" target="_top" class="btn">公式LINEを開いて送信する</a>
    <p class="warning">※必ず上のボタンをタップしてLINEを起動してください</p>
  </div>
</body>
</html>`;

    return HtmlService.createHtmlOutput(htmlTemplate);
  }
}
