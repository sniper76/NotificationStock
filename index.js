const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');
const axios = require('axios');

// 환경 변수 설정 로드
// NODE_ENV가 'development'일 때만 .env.development 로드, 그 외(기본값)는 .env.production 로드
const envFile = process.env.NODE_ENV === 'development' ? '.env.development' : '.env.production';
dotenv.config({ path: path.join(__dirname, envFile) });

console.log(`[System] '${envFile}' 설정 파일을 로드했습니다.`);

// 설정 파일 로드
const targetsPath = path.join(__dirname, 'targets.json');
let targets = [];

try {
    const data = fs.readFileSync(targetsPath, 'utf8');
    targets = JSON.parse(data);
} catch (err) {
    console.error('설정 파일(targets.json)을 읽는데 실패했습니다:', err);
    process.exit(1);
}

const schedule = require('node-schedule');
const Holidays = require('date-holidays');
const hd = new Holidays('KR');

const { WebClient } = require('@slack/web-api');
const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

// 딜레이 함수 (ms 단위)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 주가 조회 및 비교 함수
async function checkStockPrices() {
    console.log(`[${new Date().toLocaleString()}] 주가 정보를 조회합니다...`);
    let messageLines = [];
    let sellRecommendations = [];

    for (const stock of targets) {
        try {
            // 1초 ~ 3초 사이의 랜덤 딜레이
            const delay = Math.floor(Math.random() * 2000) + 1000;
            await sleep(delay);

            const url = `https://m.stock.naver.com/api/stock/${stock.code}/basic`;
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36'
                }
            });
            const data = response.data;

            // closePrice는 "123,456" 형태의 문자열이므로 쉼표 제거 후 숫자로 변환
            const currentPrice = parseInt(data.closePrice.replace(/,/g, ''), 10);
            const targetPrice = stock.target;
            const apiStockName = data.stockName;
            const configStockName = stock.name;

            // 이름 불일치 확인
            let nameMismatchInfo = '';
            if (configStockName && apiStockName && configStockName !== apiStockName) {
                nameMismatchInfo = ` (⚠️ 실제 종목명: ${apiStockName})`;
            }

            const stockName = configStockName || apiStockName; // 설정 파일 이름 우선 사용

            // 괴리율 계산: (현재가 - 목표가) / 목표가 * 100
            const disparityRate = ((currentPrice - targetPrice) / targetPrice * 100).toFixed(2);
            const disparityStr = disparityRate > 0 ? `+${disparityRate}%` : `${disparityRate}%`;
            let status = '';
            let icon = '';
            if (currentPrice >= targetPrice) {
                status = '🔵 매도 추천 (목표가 도달/초과)';
                icon = '💰';
                sellRecommendations.push({
                    name: stockName,
                    code: stock.code,
                    price: currentPrice,
                    target: targetPrice,
                    disparity: disparityStr
                });
            } else {
                status = '🔴 보유 (목표가 미달)';
                icon = '⏳';
                // 상세 리스트에는 매도 추천 제외하고 보유 종목만 추가
                messageLines.push(`${icon} *${stockName}* (${stock.code}): ${currentPrice.toLocaleString()}원 (목표: ${targetPrice.toLocaleString()}원 / 괴리율: ${disparityStr})${nameMismatchInfo}`);
            }

            const logMessage = `[${stockName} (${stock.code})] ${currentPrice.toLocaleString()}원 / 목표: ${targetPrice.toLocaleString()}원 (${disparityStr}) - ${status}${nameMismatchInfo}`;
            console.log(logMessage);

        } catch (error) {
            console.error(`[${stock.name || stock.code}] 데이터 조회 실패:`, error.message);
            messageLines.push(`⚠️ *${stock.name || stock.code}* 조회 실패`);
        }
    }

    // 슬랙으로 메시지 전송
    if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL_ID) {
        try {
            let finalMessage = `*📈 주가 모니터링 보고 (${new Date().toLocaleString()})*\n\n`;

            // 매도 추천 요약 섹션
            if (sellRecommendations.length > 0) {
                finalMessage += `🚨 *매도 추천 종목 (${sellRecommendations.length}개)* 🚨\n`;
                sellRecommendations.forEach(item => {
                    finalMessage += `• *${item.name}*: ${item.price.toLocaleString()}원 (목표가 ${item.target.toLocaleString()}원 / ${item.disparity})\n`;
                });
                finalMessage += `\n${'-'.repeat(20)}\n\n`;
            } else {
                finalMessage += `✅ 매도 추천 종목이 없습니다.\n\n${'-'.repeat(20)}\n\n`;
            }

            // 보유 종목 내역 (매도 추천 제외)
            if (messageLines.length > 0) {
                finalMessage += `*📋 보유 종목 현황*\n`;
                finalMessage += messageLines.join('\n');
            }

            await slackClient.chat.postMessage({
                channel: process.env.SLACK_CHANNEL_ID,
                text: finalMessage
            });
            console.log('슬랙 알림 전송 완료');
        } catch (error) {
            console.error('슬랙 알림 전송 실패:', error.message);
        }
    } else {
        console.log('슬랙 설정이 없어서 알림을 건너뜁니다.');
    }
}

if (process.env.NODE_ENV === 'production') {
    // 스케줄링 설정: .env 파일에서 로드 (기본값: 월~금, 09:00 ~ 15:00 매 정각)
    const cronSchedule = process.env.CRON_SCHEDULE || '0 0 9-15 * * 1-5';

    console.log(`스케줄링 설정이 로드되었습니다: "${cronSchedule}"`);

    const job = schedule.scheduleJob(cronSchedule, function () {
        const now = new Date();

        // 공휴일 체크
        if (hd.isHoliday(now)) {
            console.log(`[${now.toLocaleString()}] 오늘은 공휴일이므로 실행하지 않습니다.`);
            return;
        }

        checkStockPrices();
    });

    console.log('주가 모니터링 스케줄러가 시작되었습니다.');
    console.log('실행 시간: 월~금 09:00 ~ 15:00 (공휴일 제외)');
}
// 개발 환경일 경우 즉시 1회 실행
if (process.env.NODE_ENV === 'development') {
    console.log('개발 환경이 감지되었습니다. 즉시 1회 실행합니다.');
    checkStockPrices();
}
