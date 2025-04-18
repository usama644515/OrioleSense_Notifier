const admin = require('firebase-admin');
const axios = require('axios');

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(require('./serviceAccount.json')),
});

const db = admin.firestore();

const ONESIGNAL_APP_ID = '100056e9-7582-48ff-bfa1-9d934a6a25d8';
const ONESIGNAL_API_KEY = 'os_v2_app_caafn2lvqjep7p5btwjuu2rf3bcca3t2bzgu5cnh5ymes5mria3epg7c7s4xvqpwkhncoavq66xl5lo43yuyfhr2myqncjovll6pxfq';

async function checkLatestTemperatureAndNotify() {
  console.log('🔍 Checking latest temperature and humidity for all devices...');

  try {
    // Get all devices from deviceThresholds collection
    const thresholdsSnapshot = await db.collection('deviceThresholds').get();
    
    if (thresholdsSnapshot.empty) {
      console.log('🚫 No devices found in deviceThresholds collection.');
      return;
    }

    console.log(`📋 Found ${thresholdsSnapshot.size} devices to monitor.`);

    // Process each device
    for (const thresholdDoc of thresholdsSnapshot.docs) {
      const deviceId = thresholdDoc.id;
      const thresholds = thresholdDoc.data();
      
      console.log(`\n🔧 Processing device: ${deviceId}`);
      
      try {
        // Get the latest sensor data for this device
        const sensorSnapshot = await db
          .collection('sensorData')
          .where('deviceId', '==', deviceId)
          .orderBy('timeStamp', 'desc')
          .limit(1)
          .get();

        if (sensorSnapshot.empty) {
          console.log(`🚫 No sensor data found for device ${deviceId}.`);
          continue;
        }

        const latestDoc = sensorSnapshot.docs[0];
        const data = latestDoc.data();

        // Initialize offlineNotificationSent if it doesn't exist
        if (data.offlineNotificationSent === undefined) {
          await latestDoc.ref.update({ offlineNotificationSent: false });
          data.offlineNotificationSent = false;
        }

        // Check for device offline alert
        const lastTimestamp = new Date(data.timestamp.replace(' ', 'T')).getTime();
        const now = Date.now();
        const diffMinutes = (now - lastTimestamp) / (1000 * 60);

        console.log(`🔄 Last timestamp: ${new Date(lastTimestamp).toLocaleString()}`);
        console.log(`🕒 Current time: ${new Date(now).toLocaleString()}`);
        console.log(`⏳ Time difference: ${diffMinutes} minutes`);
        
        if (diffMinutes > 10 && !data.offlineNotificationSent) {
          const offlineMessage = `🚫 Device Offline Alert!\nDevice: ${data.deviceName || 'Unknown'}\nLast Updated: ${new Date(lastTimestamp).toLocaleString()}`;

          const deviceSnapshot = await db.collection('devices').get();
          const playerIds = [];

          deviceSnapshot.forEach(deviceDoc => {
            const deviceData = deviceDoc.data();
            if (deviceData.playerId) {
              playerIds.push(deviceData.playerId);
            }
          });

          if (playerIds.length > 0) {
            await axios.post(
              'https://onesignal.com/api/v1/notifications',
              {
                app_id: ONESIGNAL_APP_ID,
                include_player_ids: playerIds,
                headings: { en: '📡 Device Offline Alert' },
                contents: { en: offlineMessage },
              },
              {
                headers: {
                  Authorization: `Basic ${ONESIGNAL_API_KEY}`,
                  'Content-Type': 'application/json',
                },
              }
            );

            await latestDoc.ref.update({
              offlineNotificationSent: true,
              lastNotificationTime: admin.firestore.FieldValue.serverTimestamp(),
            });

            console.log('📡 Offline notification sent.');
          }
        }

        const temperature = parseFloat(data.temperature);
        const humidity = parseFloat(data.humidity);
        const timestampStr = data.timestamp;
        const dateObj = new Date(timestampStr.replace(' ', 'T'));

        const formattedTime = dateObj.toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });

        console.log(`📊 Latest reading: ${temperature}°C, ${humidity}% at ${formattedTime}`);

        // Check if we need to send any notifications
        let shouldNotify = false;
        let notificationTitle = '';
        let notificationMessage = '';

        if (temperature >= thresholds.tempMax && !data.tempNotificationSent) {
          shouldNotify = true;
          notificationTitle = '🌡️ High Temperature Alert';
          notificationMessage = `🔥 High Temperature Detected!\nDevice: ${data.deviceName || 'Unknown'}\nTemperature: ${temperature}°C (Max: ${thresholds.tempMax}°C)\nTime: ${formattedTime}`;
        } else if (temperature <= thresholds.tempMin && !data.tempNotificationSent) {
          shouldNotify = true;
          notificationTitle = '🌡️ Low Temperature Alert';
          notificationMessage = `❄️ Low Temperature Detected!\nDevice: ${data.deviceName || 'Unknown'}\nTemperature: ${temperature}°C (Min: ${thresholds.tempMin}°C)\nTime: ${formattedTime}`;
        } else if (humidity >= thresholds.humidityMax && !data.humidityNotificationSent) {
          shouldNotify = true;
          notificationTitle = '💧 High Humidity Alert';
          notificationMessage = `💦 High Humidity Detected!\nDevice: ${data.deviceName || 'Unknown'}\nHumidity: ${humidity}% (Max: ${thresholds.humidityMax}%)\nTime: ${formattedTime}`;
        } else if (humidity <= thresholds.humidityMin && !data.humidityNotificationSent) {
          shouldNotify = true;
          notificationTitle = '💧 Low Humidity Alert';
          notificationMessage = `🏜️ Low Humidity Detected!\nDevice: ${data.deviceName || 'Unknown'}\nHumidity: ${humidity}% (Min: ${thresholds.humidityMin}%)\nTime: ${formattedTime}`;
        }

        // Send notification if needed
        if (shouldNotify) {
          const deviceSnapshot = await db.collection('devices').get();
          const playerIds = [];

          deviceSnapshot.forEach(deviceDoc => {
            const deviceData = deviceDoc.data();
            if (deviceData.playerId) {
              playerIds.push(deviceData.playerId);
            }
          });

          if (playerIds.length > 0) {
            await axios.post(
              'https://onesignal.com/api/v1/notifications',
              {
                app_id: ONESIGNAL_APP_ID,
                include_player_ids: playerIds,
                headings: { en: notificationTitle },
                contents: { en: notificationMessage },
              },
              {
                headers: {
                  Authorization: `Basic ${ONESIGNAL_API_KEY}`,
                  'Content-Type': 'application/json',
                },
              }
            );

            // Update notification flags
            const updateData = {
              lastNotificationTime: admin.firestore.FieldValue.serverTimestamp(),
            };

            if (temperature >= thresholds.tempMax || temperature <= thresholds.tempMin) {
              updateData.tempNotificationSent = true;
            }

            if (humidity >= thresholds.humidityMax || humidity <= thresholds.humidityMin) {
              updateData.humidityNotificationSent = true;
            }

            await latestDoc.ref.update(updateData);
            console.log(`📲 Notification sent to ${playerIds.length} users.`);
          } else {
            console.log('⚠️ No player IDs found.');
          }
        }

        // Reset flags if values are back to normal
        const resetData = {};
        if (
          temperature < thresholds.tempMax &&
          temperature > thresholds.tempMin &&
          data.tempNotificationSent
        ) {
          resetData.tempNotificationSent = false;
        }

        if (
          humidity < thresholds.humidityMax &&
          humidity > thresholds.humidityMin &&
          data.humidityNotificationSent
        ) {
          resetData.humidityNotificationSent = false;
        }

        if (
          diffMinutes <= 10 &&
          data.offlineNotificationSent
        ) {
          resetData.offlineNotificationSent = false;
        }

        if (Object.keys(resetData).length > 0) {
          await latestDoc.ref.update(resetData);
          console.log('🔄 Reset notification flags for normal values.');
        }
      } catch (error) {
        console.error(`❌ Error processing device ${deviceId}:`, error.message);
      }
    }
  } catch (error) {
    console.error('❌ Error in checkLatestTemperatureAndNotify:', error.message);
  }
}

// Run every 1 minute
setInterval(checkLatestTemperatureAndNotify, 1 * 60 * 1000);

console.log('✅ Temperature, humidity, and offline monitoring started (runs every 1 minute)...');