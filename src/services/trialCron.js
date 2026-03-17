// src/services/trialCron.js
// Trial biten kullanıcılara otomatik uyarı e-postası gönderir
// Her gün bir kez çalışır (server.js tarafından başlatılır)

const db = require('../db/database');
const { sendTrialEnding, sendTrialExpired } = require('./email');

async function runTrialCheck() {
  console.log('[TrialCron] Kontrol başladı:', new Date().toISOString());

  try {
    const now   = new Date();
    const users = db.prepare("SELECT id, name, email, trial_ends, trial_warning_sent FROM users WHERE plan = 'trial' AND trial_ends IS NOT NULL").all();

    for (const user of users) {
      const trialEnd  = new Date(user.trial_ends);
      const daysLeft  = Math.ceil((trialEnd - now) / 86400000);
      const warnSent  = user.trial_warning_sent || 0;

      // 7 gün kaldı — ilk uyarı (bit 1)
      if (daysLeft <= 7 && daysLeft > 3 && !(warnSent & 1)) {
        await sendTrialEnding({ name: user.name, email: user.email, daysLeft, trialEnds: user.trial_ends }).catch(e => console.error('[TrialCron] 7d mail:', e.message));
        db.prepare("UPDATE users SET trial_warning_sent = trial_warning_sent | 1 WHERE id = ?").run(user.id);
        console.log(`[TrialCron] 7-gün uyarısı: ${user.email}`);
      }

      // 3 gün kaldı — ikinci uyarı (bit 2)
      if (daysLeft <= 3 && daysLeft > 0 && !(warnSent & 2)) {
        await sendTrialEnding({ name: user.name, email: user.email, daysLeft, trialEnds: user.trial_ends }).catch(e => console.error('[TrialCron] 3d mail:', e.message));
        db.prepare("UPDATE users SET trial_warning_sent = trial_warning_sent | 2 WHERE id = ?").run(user.id);
        console.log(`[TrialCron] 3-gün uyarısı: ${user.email}`);
      }

      // Trial bitti (bit 4)
      if (daysLeft <= 0 && !(warnSent & 4)) {
        await sendTrialExpired({ name: user.name, email: user.email }).catch(e => console.error('[TrialCron] expired mail:', e.message));
        db.prepare("UPDATE users SET trial_warning_sent = trial_warning_sent | 4 WHERE id = ?").run(user.id);
        console.log(`[TrialCron] Trial bitti bildirimi: ${user.email}`);
      }
    }

    console.log(`[TrialCron] Tamamlandı. ${users.length} kullanıcı kontrol edildi.`);
  } catch (e) {
    console.error('[TrialCron] Hata:', e.message);
  }
}

// Günde bir kez çalıştır (24 saat = 86400000 ms)
function startTrialCron() {
  // İlk çalıştırma: 5 dakika sonra (server soğuma süresi)
  setTimeout(() => {
    runTrialCheck();
    setInterval(runTrialCheck, 24 * 60 * 60 * 1000);
  }, 5 * 60 * 1000);

  console.log('[TrialCron] Günlük kontrol zamanlandı.');
}

module.exports = { startTrialCron, runTrialCheck };
