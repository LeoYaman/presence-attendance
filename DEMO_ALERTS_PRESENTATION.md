# Kurgusal uyarı demosu: sunum notları

Bu belge ileride hazırlanacak sunum için konuşma ve gösterim notlarıdır; bir sunum dosyası değildir.

## Amaç ve sınırlar

Presence içindeki bağımsız `/demo-alerts.html` sayfası, veritabanından gelen değişken bir kurgusal senaryo listesini gösterir. Tüm kayıtlar sentetiktir. Gerçek suçlu listesi, gerçek kişi, fotoğraf, kamera veya yüz eşleşmesi kullanılmaz. Katılım kaydı ve tanıma akışları bu demoya bağlanmaz.

“DEMO — Faculty security is getting informed” başlığı yalnızca ekrandaki bir senaryo sonucudur. Fakülte güvenliğine veya başka bir kişiye gerçek arama, bildirim veya mesaj gönderilmez. Bu açıklama, simülasyon öncesinde ve sonrasında görünür kalır. Metnin değiştirilmesi yanlış pozitif oranını azaltmaz; demo sentetiktir ve uyarı yalnızca açık kullanıcı eylemiyle tetiklenir.

## Yerelde çalıştırma

PowerShell'de `C:\Users\XC-831\Desktop\Code\presence-attendance\Backend` klasöründen `npm run start:local` komutunu çalıştırın. Varsayılan adreste [demo sayfasını açın](http://localhost:3000/demo-alerts.html). Yerel başlatıcı bu sayfa için sentetik öğretmen oturumu sağlar. Port değiştirilmişse başlatıcının gösterdiği adresi kullanın.

Bu yol yerel PGlite demosudur; Tiger Data veya TimescaleDB bulut doğrulaması değildir. Proje kökündeki `assets/demo-alert-feed.json` kurgusal kaynak dosyası varsayılan olarak 5 saniyede bir veritabanıyla senkronize edilir. Ön yüzün 10 saniyelik API yenilemesi ile kaynak dosyadan veritabanına senkronizasyon iki ayrı süreçtir. Kaynak dosya değişikliğinin görünmesi için önce sunucu senkronizasyonunun, sonra sayfa yenilemesinin başarılı olması gerekir.

## Gösterim akışı

1. Yetkili demo hesabıyla oturum açın ve `/demo-alerts.html` sayfasını açın.
2. Listenin `GET /api/demo-alerts` üzerinden geldiğini açıklayın. Sayfa açıkken başarılı yenilemeler arasında yaklaşık 10 saniye vardır; istek süresi bu aralığa eklenebilir.
3. `assets/demo-alert-feed.json` dosyasının `records` dizisine yeni bir kurgusal kayıt ekleyin (`demo-` ile başlayan benzersiz `id`, `name`, `scenario`, `synthetic:true`, `fictional:true`). Kaynak dosyası yaklaşık 5 saniyede DB'ye senkronize edilir; sayfanın sonraki başarılı yenilemesinde görünür.
4. Aynı kaydın adını veya senaryosunu güncelleyin. Sonraki başarılı yenilemede seçili kaydın ayrıntılarının güncellenmesini gösterin.
5. Seçili kaydı kaldırın. Sonraki başarılı yenilemede seçim ve önceki simülasyon sonucunun temizlendiğini gösterin. Boş liste durumunda simülasyon kullanılamaz.
6. Bir kurgusal kayıt seçip “Simulate demo alert” düğmesine basın. `POST /api/demo-alerts/simulate` yalnızca `{id}` gönderir; kimlik ve yetki sunucudan belirlenir. Oturumdan alınan `csrfToken`, `X-CSRF-Token` başlığıyla gönderilir.
7. Sonuçta `synthetic: true` ve `notificationSent: false` olduğunu belirtin. Seçim veya otomatik yenileme senaryoyu tetiklemez. Tetikleme açık bir kullanıcı eylemidir; bir yüz eşleşmesinin sonucu değildir.

## Doğruluk ve hata durumları

- Kaynak yanıtı `{synthetic:true, records:[{id,name,scenario,...}],...}` olmalıdır. Ön yüzde kullanıcı kaynaklı metinler HTML olarak işlenmez.
- Başarısız yenilemede eski ayrıntılar görünse bile simülasyon kapatılır; son başarılı yenileme zamanı korunur ve hata gösterilir.
- Kaynak dosya geçersizse önceki geçerli veritabanı kayıtları korunur. API'nin `sync.lastError` değeri sayfada güncel kaynak değişikliklerinin yansımayabileceğini açıklayan bir uyarıyla gösterilir; `sync.lastSyncedAt` varsa son kaynak senkronizasyon zamanı da görünür.
- Oturum sona erdiğinde liste ve sonuç temizlenir. Yeniden giriş sonrası “Refresh feed” ile bağlanılır.
- Başarısız simülasyon başarı gibi sunulmaz. Kayıt silinmesi gibi yarış durumlarında sunucu mevcut kaydı tekrar doğrulamalıdır.
- Gerçek veritabanı senkronizasyonu iddiası yalnızca bu API'nin bağlı olduğu veritabanı için geçerlidir. Yerel demo kullanılıyorsa bu durum açıkça belirtilir; yerel test, bulut veritabanı doğrulaması değildir.

## Mahremiyet ve yanlış eşleşme anlatımı

Bir kaynağın herkese açık olması, biyometrik işleme ve kişilerin takip edilmesiyle ilgili mahremiyet sorunlarını ortadan kaldırmaz. Yanlış eşleşme riski de devam eder. Bu nedenle sunum, kamuya açık gerçek suçlu listelerine bağlantı vermemeli ve bir kişiyi yüz görüntüsünden suç kaydıyla ilişkilendirdiği izlenimini yaratmamalıdır. Buradaki kurgusal senaryo seçimi, gerçek yüz tanıma veya bir kişiye ilişkin suç isnadı için doğrulama değildir.

## Kabul kontrolü

- Yetkisiz hesap API'ye erişemez; simülasyon CSRF koruması gerektirir.
- Veritabanındaki ekleme, güncelleme ve kaldırma işlemleri bir sonraki başarılı yenilemede görünür.
- Hiçbir senaryo otomatik tetiklenmez; her tetikleme açık düğme eylemidir.
- Görünen tüm sonuçlarda demo açıklaması bulunur; harici bildirim veya arama yoktur.
- Dar ekranda seçim, düğme, hata ve açıklama okunabilir; klavye ile kullanılabilir.
