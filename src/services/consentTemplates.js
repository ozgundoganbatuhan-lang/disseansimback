'use strict';
// Hazır onam şablonları. Klinik göndermeden önce metni düzenleyebilir; hekim kendi mesleki sorumluluğuyla son halini verir.
const ORTAK = `

Bu formu imzalamadan önce hekimime soru sorma fırsatım oldu; sorularım anlaşılır biçimde yanıtlandı. Tedaviyi kabul etmeme hakkım ve tedavinin herhangi bir aşamasında vazgeçebileceğim bana açıklandı. Tedavi sırasında beklenmeyen bir durum ortaya çıkarsa hekimimin, sağlığımı korumak için gerekli gördüğü ek işlemleri yapabileceğini ve bunu mümkün olan ilk anda bana bildireceğini biliyorum. Tıbbi geçmişim, kullandığım ilaçlar ve alerjilerim hakkında verdiğim bilgilerin doğru ve eksiksiz olduğunu beyan ederim.`;

const T = (key, title, body) => ({ key, title, body: body.trim() + ORTAK });

const TEMPLATES = [
  T('genel', 'Genel muayene ve tedavi onamı', `
Ağız ve diş muayenemin yapılmasına; gerekli görülmesi halinde röntgen çekilmesine, diş taşı temizliği, dolgu gibi rutin tedavilerin uygulanmasına onay veriyorum. Muayene sonucunda önerilen tedavi planı, alternatif tedaviler, tahmini süre ve ücret hakkında bilgilendirildim. Lokal anestezi uygulanabileceğini; anestezinin uyuşukluk, nadiren morarma, alerjik reaksiyon veya geçici sinir etkilenmesi gibi yan etkileri olabileceğini anladım.`),
  T('dolgu', 'Dolgu tedavisi onamı', `
Çürük veya kırık nedeniyle dişime/dişlerime dolgu yapılacağı bana açıklandı. İşlem sonrasında geçici hassasiyet, ısırma hassasiyeti ve nadiren dişin sinirinin etkilenmesi sonucu kanal tedavisi ihtiyacı doğabileceğini; derin çürüklerde bu ihtimalin arttığını anladım. Dolgunun ömrünün ağız hijyeni, beslenme alışkanlıkları ve diş sıkma gibi etkenlere bağlı olduğunu, zamanla yenilenmesi gerekebileceğini biliyorum.`),
  T('kanal', 'Kanal tedavisi onamı', `
Dişimin sinir dokusunun iltihaplandığı veya canlılığını yitirdiği, bu nedenle kanal tedavisi önerildiği bana açıklandı. Alternatifinin dişin çekimi olduğunu biliyorum. Tedavinin birden fazla seans sürebileceğini; tedavi sonrası birkaç gün ağrı ve hassasiyet olabileceğini; kanal içinde alet kırılması, kanalın tıkalı olması, kök delinmesi gibi komplikasyonların nadiren görülebileceğini ve bazı durumlarda tedavinin başarısız olup kök ucu ameliyatı veya çekim gerekebileceğini anladım. Kanal tedavisi görmüş dişin kırılmaya daha yatkın olduğunu, kuron (kaplama) önerilebileceğini biliyorum.`),
  T('cekim', 'Diş çekimi ve ağız cerrahisi onamı', `
Dişimin/dişlerimin çekimi (gömülü diş operasyonu dahil) bana önerildi ve nedenleri açıklandı. İşlem sonrası ağrı, şişlik, morarma, kanama, ağız açıklığında kısıtlılık ve kuru soket (alveolit) görülebileceğini; nadiren komşu dişlerde hasar, çene kemiğinde kırık, sinüs ilişkisi veya dudak, dil ve çenede geçici ya da kalıcı uyuşukluk olabileceğini anladım. İşlem sonrası verilen talimatlara (sigara içmemek, sıcak yiyecekten kaçınmak, ilaçları düzenli kullanmak) uymanın iyileşme için önemli olduğunu biliyorum.`),
  T('implant', 'İmplant tedavisi onamı', `
Eksik dişlerimin yerine çene kemiğine titanyum implant yerleştirileceği, iyileşme süresinin ardından üst yapının (kuron/köprü/protez) yapılacağı bana açıklandı. Alternatiflerinin köprü veya hareketli protez olduğunu biliyorum. Gerekirse kemik tozu veya sinüs kaldırma gibi ek işlemler uygulanabileceğini; ameliyat sonrası ağrı, şişlik, morarma ve enfeksiyon görülebileceğini; nadiren implantın kemikle kaynaşmayıp çıkarılması, sinir hasarına bağlı uyuşukluk veya sinüs komplikasyonu olabileceğini anladım. Sigara, diyabet ve yetersiz ağız bakımının başarıyı olumsuz etkilediğini, implantın düzenli kontrol ve bakım gerektirdiğini biliyorum.`),
  T('protez', 'Protez (kuron, köprü, hareketli protez) onamı', `
Dişlerim için kuron, köprü veya hareketli protez yapılacağı bana açıklandı. Bu işlem için dişlerimin kesilerek küçültülebileceğini, kesilen dişlerde hassasiyet ve nadiren kanal tedavisi ihtiyacı doğabileceğini; ölçü, prova ve uyumlama için birden fazla seans gerekeceğini anladım. Renk ve şeklin prova aşamasında birlikte belirleneceğini; hareketli protezlere alışmanın zaman alabileceğini, konuşma ve çiğnemede geçici zorluk olabileceğini biliyorum.`),
  T('ortodonti', 'Ortodontik tedavi onamı', `
Dişlerimin/çocuğumun dişlerinin teller, şeffaf plaklar veya apareylerle düzeltileceği bana açıklandı. Tedavi süresinin yaklaşık olduğunu ve uyuma göre değişebileceğini; tedavi sırasında ağrı, yara, çürük ve diş eti iltihabı riskinin arttığını; nadiren kök erimesi ve çene eklemi şikâyetleri görülebileceğini anladım. Tedavi sonrası pekiştirme apareylerinin önerildiği şekilde kullanılmazsa dişlerin eski konumuna dönebileceğini biliyorum.`),
  T('beyazlatma', 'Diş beyazlatma onamı', `
Dişlerime ofis tipi ve/veya ev tipi beyazlatma uygulanacağı bana açıklandı. Ulaşılacak beyazlık derecesinin kişiden kişiye değiştiğini ve garanti edilemeyeceğini; dolgu, kaplama ve implant gibi restorasyonların renginin değişmeyeceğini; işlem sonrası geçici diş hassasiyeti ve diş eti tahrişi olabileceğini; sonucun kalıcılığının beslenme ve sigara alışkanlıklarına bağlı olduğunu anladım.`),
  T('cocuk', 'Çocuk hasta için veli onamı', `
Velisi/yasal temsilcisi olduğum çocuğumun muayene ve tedavisine onay veriyorum. Uygulanacak tedavi, olası riskler ve alternatifler bana açıklandı. Çocuğumun tedaviye uyum göstermemesi halinde tedavinin ertelenebileceğini veya başka bir merkeze yönlendirilebileceğini; tedavi sırasında çocuğumun güvenliği için kısa süreli tutma gibi davranış yönlendirme tekniklerinin uygulanabileceğini anladım.`),
  T('kvkk', 'Kişisel sağlık verilerinin işlenmesine açık rıza', `
Kimlik, iletişim ve sağlık verilerimin (muayene bulguları, röntgen ve fotoğraflar, tedavi kayıtları); tedavimin planlanması ve yürütülmesi, randevu hatırlatması, faturalandırma ve yasal yükümlülüklerin yerine getirilmesi amacıyla klinik tarafından işlenmesine, bu amaçla sınırlı olarak hizmet alınan yazılım ve barındırma sağlayıcılarına aktarılmasına açık rıza veriyorum. 6698 sayılı KVKK kapsamındaki haklarımın (bilgi talep etme, düzeltme, silme, itiraz) bana açıklandığını ve bu rızayı dilediğim zaman geri alabileceğimi biliyorum.`),
];

module.exports = { TEMPLATES };
