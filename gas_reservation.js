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

  if (!requestDate) {
    return ContentService.createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);
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

  // 7:00 から 18:00 まで、30分枠(30分刻み)でチェック
  for (let m = START_HOUR * 60; m <= END_HOUR * 60; m += 30) {
    let hh = String(Math.floor(m / 60)).padStart(2, '0');
    let mm = String(m % 60).padStart(2, '0');
    let slotStart = new Date(requestDate + 'T' + hh + ':' + mm + ':00+09:00');
    // この枠に予約を入れた場合に必要な「拘束時間」＝前1時間〜後1時間の合計3時間
    let requiredStart = new Date(slotStart.getTime() - PADDING_MINUTES * 60 * 1000);
    let requiredEnd = new Date(slotStart.getTime() + (EVENT_DURATION_MINUTES + PADDING_MINUTES) * 60 * 1000);

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

  let startTime = new Date(date + 'T' + time + ':00+09:00');
  let endTime = new Date(startTime.getTime() + (EVENT_DURATION_MINUTES * 60 * 1000));

  // 今すぐ予約を入れた場合に必要となる「前後の拘束時間」を含めた範囲で再チェック
  let requiredStart = new Date(startTime.getTime() - PADDING_MINUTES * 60 * 1000);
  let requiredEnd = new Date(startTime.getTime() + (EVENT_DURATION_MINUTES + PADDING_MINUTES) * 60 * 1000);

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
    let eventDesc = "プラン: " + plan + "\n場所: " + location + "\n電話番号: " + phone + "\nメール: " + email + "\n備考: " + notes;
    cal.createEvent(name + '様撮影：' + plan, startTime, endTime, {
      description: eventDesc,
      location: location
    });

    // スプレッドシートへ記録
    let sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    sheet.appendRow([new Date(), name, email, phone, plan, location, date, time, notes]);

    // LINEへのリダイレクトURLを作成
    let message = "【ご予約のお申し込み】\n"
      + "■お名前：" + name + " 様\n"
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

    return HtmlService.createHtmlOutput(
      '<div style="font-family:sans-serif; text-align:center; padding: 50px; line-height: 1.8;">'
      + '<b>ご予約処理が完了しました！</b><br><br>'
      + '引き続き、<b>公式LINEを起動</b>してメッセージを送信してください。<br><br>'
      + '<a href="' + lineUrl + '" style="display:inline-block; padding: 15px 30px; background: #06C755; color: #fff; text-decoration: none; border-radius: 50px; font-weight: bold;">LINEアプリを起動する</a>'
      + '</div>'
      + '<script>setTimeout(function(){ window.top.location.href = "' + lineUrl + '"; }, 1500);</script>'
    );
  }
}
