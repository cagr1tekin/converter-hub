# Converter Hub

Yerel çalışan, modüler dönüştürme aracı. Dosya sayısı, boyut ve süre sınırı yok —
her şey bu makinede olur, hiçbir dosya dışarı çıkmaz.

```bash
pnpm go
```

Tek komut. Tarayıcı kendiliğinden açılır: **http://localhost:4747**

`pnpm go` eksik olan ne varsa kendisi tamamlar ve **sadece gerekeni** yapar:

| Adım | Ne yapar |
|---|---|
| Bağımlılıklar | `node_modules` yoksa `pnpm install` çalıştırır |
| ffmpeg | `bin/ffmpeg.exe` yoksa indirir (~100 MB, tek seferlik) |
| Modüller | `modules/` klasörünü tarar, registry'yi üretir |
| Docker | Ayakta mı bakar. Değilse **durmaz** — sadece o modüller beklemede kalır |
| Derleme | Kaynak dosyalar son derlemeden yeniyse yeniden derler, değilse atlar |
| Sunucu | Boş port bulur, başlatır, tarayıcıyı açar |

Hiçbir şey değişmediyse başlatma **~2 saniye**. Windows'ta `Baslat.bat`'a çift tıklamak da aynı işi yapar.

```bash
pnpm go          # normal kullanım (production build, hızlı)
pnpm go:dev      # geliştirme — kod değişince anında yenilenir, derleme beklemez
```

Port meşgulse bir üstünü dener. Sabitlemek için: `PORT=5000 pnpm go`

### Docker gerektiren modüller

Arka plan silme container'ını **elle başlatman gerekmez** — modül ilk çalıştırıldığında
imajı çeker, container'ı oluşturur ve hazır olmasını bekler. Docker kapalıysa modül
listede uyarıyla soluk görünür, uygulama çalışmaya devam eder.

## Yeni modül eklemek

`modules/` altına bir klasör aç, içine `module.ts` koy. **Başka hiçbir dosyaya dokunma.**

```
modules/
  benim-modulum/
    module.ts     ← tek gereken bu
```

```ts
import { defineModule } from "@/core/types";

export default defineModule({
  id: "benim-modulum",          // klasör adıyla aynı olmalı
  name: "Benim modülüm",
  description: "Ne yaptığı.",
  category: "image",            // image | video | audio | document | utility
  engine: "inproc",             // inproc | binary | docker
  icon: "✨",

  inputMode: "files",           // "none" ise dosya alanı hiç görünmez
  accepts: { ext: ["png", "jpg"], multiple: true },

  options: [
    { key: "kalite", type: "number", label: "Kalite", default: 80, min: 1, max: 100 },
    { key: "gelismis", type: "boolean", label: "Bir şey", default: false, advanced: true },
  ],

  async run({ inputs, outDir, options, onProgress, log, signal }) {
    const outputs = [];
    for (const [i, file] of inputs.entries()) {
      signal.throwIfAborted();         // kullanıcı iptal ettiyse burada durur
      // ... işini yap, outDir içine yaz ...
      onProgress(((i + 1) / inputs.length) * 100, `${i + 1}/${inputs.length}`);
    }
    return { outputs, summary: `${outputs.length} dosya işlendi` };
  },
});
```

Sonraki `pnpm dev` / `pnpm build` çalıştığında modül kendiliğinden listeye girer.
Elle kayıt tutmak yok.

### Arayüz kendiliğinden oluşur

`options` dizisinden form otomatik render edilir — frontend'e tek satır yazmazsın.

| `type` | Ne çıkar |
|---|---|
| `select` | Açılır liste |
| `number` | Sayı alanı (tabular rakamlar) |
| `boolean` | Anahtar (switch) |
| `text` | Metin alanı; `multiline: true` ile çok satırlı, `#rrggbb` varsayılanla renk seçici |

İki yardımcı alan:
- `showWhen: { key, equals }` — başka bir ayar belli değerdeyken göster (ör. kalite sadece JPEG'de).
- `advanced: true` — "Gelişmiş ayarlar" açılırının içine koy. Yaygın yol görünür kalır.

### Bağımlılığı olan modüller

`health()` ekle. Bağımlılık yoksa modül gri görünür ve kullanıcı **ne kuracağını** okur:

```ts
async health() {
  const ok = await ffmpegVarMi();
  return ok ? { ok: true } : { ok: false, reason: "ffmpeg bulunamadı. bin/ içine koy." };
}
```

## Mimari

```
app/
  page.tsx              sunucu bileşeni, modül listesini verir
  workbench.tsx         tüm arayüz
  option-field.tsx      şemadan form üreten alan
  api/
    modules/            GET  modül listesi + health
    jobs/               POST iş başlat
    jobs/[id]/          GET durum, DELETE iptal
    jobs/[id]/events/   SSE canlı ilerleme
    jobs/[id]/zip/      akışlı ZIP indirme
    files/[...path]/    çıktı indirme (workspace dışına çıkamaz)
core/
  types.ts              modül sözleşmesi
  registry.ts           modülleri toplar, health'i önbellekler
  jobs.ts               bellek içi iş kuyruğu + ilerleme yayını
  workspace.ts          dosya alanı, yol güvenliği, eski iş temizliği
  zip.ts                bağımlılıksız store-only ZIP yazıcı
modules/                her klasör = bir modül
workspace/              girdi ve çıktılar (gitignored, 24 saatte bir temizlenir)
```

**Üç çalıştırma katmanı** — `engine` alanı hangisi olduğunu söyler ve arayüzde rozet olarak görünür:

| Katman | Ne için | Nasıl |
|---|---|---|
| `inproc` | Görsel, QR, metin | Node içinde, dış bağımlılık yok |
| `binary` | Video, ses, OCR | `./bin` altındaki çalıştırılabilir dosyaya spawn |
| `docker` | AI modelleri | Container'a HTTP |

### Registry neden codegen?

Next.js sunucu kodunu önceden paketler; çalışma anında bulunan bir yoldan
`import()` production build'de çözülemez. `scripts/gen-registry.mjs` klasörü tarayıp
statik import'lar üretir — böylece hem `next dev` hem `next build` çalışır, sen yine
sadece klasör eklersin. `predev` ve `prebuild` ile otomatik koşar.

## Mevcut modüller

| Modül | Motor | Katman |
|---|---|---|
| Görsel dönüştür (PNG/JPEG/WEBP/AVIF/TIFF) | sharp | `inproc` |
| Görsel boyutlandır / sıkıştır | sharp | `inproc` |
| QR kod üret (PNG/SVG, toplu) | qrcode | `inproc` |
| Video dönüştür (DAT/MPG/AVI/MKV → MP4/MKV/WEBM/MOV/GIF) | ffmpeg | `binary` |
| Ses dönüştür / videodan çıkar (MP3/M4A/WAV/FLAC/Opus) | ffmpeg | `binary` |
| Arka plan sil (AI) | rembg | `docker` |
| PDF → Markdown / düz metin | pdf.js | `inproc` |

Video ve ses modülleri `bin/ffmpeg.exe` ister; `pnpm go` bunu kendisi indirir.
Elle yenilemek için: `pnpm ffmpeg --force`

### Docker sidecar'lar

`engine: "docker"` modülleri kendi container'larını **kendileri yönetir** — `core/docker.ts`
imaj yoksa çeker, container yoksa oluşturur, durmuşsa başlatır ve hazır olmasını bekler.
Ayrı bir compose dosyası yok; tek doğruluk kaynağı modülün kendi `SidecarSpec`'i.

| Modül | Container | Port | Kalıcı veri |
|---|---|---|---|
| Arka plan sil | `converter-hub-rembg` | 7333 | `converter-hub-rembg-models` (model önbelleği) |

> **Bu makinede Docker kararsız.** 15.6 GB RAM'in ~3 GB'ı boş; WSL2 varsayılan olarak
> yarısını (~7.8 GB) istiyor ve bulamayınca VM çöküyor. `bg-remove` kodu test edilmiş
> ve çalışır durumda, ama Docker ayakta olduğunda kullan. Kalıcı çözüm: `.wslconfig`
> ile WSL2'ye 5 GB tavan koymak.

Ders alınan üç şey:
- **Model önbellek yolu `/root/.rembg`** — `/root/.u2net` değil. Yanlış bağlarsan her
  yeniden başlatmada yüzlerce MB tekrar iner.
- **Hazırlık yolu `/api`** — rembg'in `--no-ui` modunda `/docs` 404 döner.
- **Bellek limiti şart.** Limitsiz bırakılırsa büyük bir model Docker'ın tamamını
  sıkıştırır. Container `--memory 6g` ile çalışır; aşarsa sadece o container ölür
  ve modül bunu OOM olarak raporlar.

### PDF ayrıştırma nasıl çalışıyor

PDF'te "başlık" veya "tablo" diye bir şey yoktur — sadece koordinatlardaki harfler vardır.
`core/pdf-text.ts` yapıyı geometriden çıkarır:

| Sinyal | Çıkarım |
|---|---|
| Gövdeden büyük punto | Başlık; boyut sırasına göre `#`, `##`, `###` |
| Girintili ardışık satırlar | Liste (madde işareti çoğu PDF'te metin katmanında yoktur, vektör çizilir) |
| Üst üste hizalanmış sütunlar | Tablo |
| Satır sonundaki tire | Bölünmüş kelime, birleştirilir |
| Her sayfada aynı yerde tekrarlayan **küçük punto** satır | Üstbilgi/altbilgi, atılır |

Son satırdaki "küçük punto" şartı önemli: onsuz "Bölüm 1", "Bölüm 2" gibi gerçek
başlıklar da tekrar sanılıp siliniyordu.

**Sınır:** metin katmanı okunur. Taranmış PDF bir görüntüdür, içinde metin yoktur —
o OCR ister ve ayrı bir modül olacak. Modül bu durumu tespit edip kayda yazar.

### GPU kodlama (NVENC)

Video modülü GPU'yu denemeden önce kodlayıcıyı **gerçekten açmayı** dener — bir
kodlayıcının `-encoders` listesinde olması çalışacağı anlamına gelmiyor. Açılmazsa
iş hata vermez, sessizce CPU'ya düşer ve sebebi kayda yazar.

Bu makinede sürücü 616.56 ile NVENC **çalışıyor**. Ölçüm (1080p 30 sn kaynak):

| Yol | Süre | Çıktı |
|---|---|---|
| CPU `libx264` | 8.0 s | 34 MB |
| GPU `h264_nvenc` | 4.2 s | 55 MB |
| GPU `hevc_nvenc` | 5.1 s | 34 MB |

Donanım kodlayıcıları bit başına daha az verimli — aynı kalite hedefinde NVENC H.264
daha büyük dosya üretir. `hevc_nvenc` ikisinin ortası: CPU kadar küçük, belirgin daha hızlı.

## Yol haritası

**Faz 2 — `binary` katmanı** ✅ tamamlandı

Not düşülen kararlar:
- `fluent-ffmpeg` **kullanılmadı** — Mayıs 2025'te arşivlendi, güncel ffmpeg ile
  düzgün çalışmadığı notuyla. Komutlar `core/ffmpeg.ts` içinde doğrudan kuruluyor.
- `ffmpeg.wasm` **kullanılmadı** — ~2GB bellek tavanı var, "sınırsız" şartıyla çelişir.

**Faz 3** ✅ tamamlandı

- Arka plan silme: [rembg](https://github.com/danielgatis/rembg) (MIT), Docker sidecar.
  Host kurulumu mümkün değil — paket `python >=3.11,<3.14` istiyor, makinede 3.14.1 var.
- PDF → Markdown: **Docling yerine pdf.js** seçildi. Docling daha sadık bir yapı
  çıkarır ama PyTorch ile 2-4 GB RAM ister; bu makinenin Docker VM'i bunu kaldırmıyor.
  pdf.js metin katmanını doğrudan okur, model gerektirmez, anında başlar.

**Sırada**
- OCR (taranmış PDF ve görselden metin) — Tesseract, `binary` katmanı.
- Office → PDF — LibreOffice headless, `binary` veya `docker`.
- PDF araçları (birleştir/böl/sıkıştır) — [Stirling-PDF](https://github.com/Stirling-Tools/Stirling-PDF) container.

## Lisans notları

Bu depoya kod kopyalarken:

| Durum | Projeler |
|---|---|
| Serbestçe gömülebilir | sharp (Apache-2.0), qrcode (MIT), rembg (MIT), Docling (MIT) |
| Sadece ayrı container/süreç olarak çalıştır | ConvertX, imgly background-removal (AGPL-3.0), Stirling-PDF (open-core) |
| Kodunu kopyalama, fikrini al | it-tools (GPL-3.0) |
| Ticari kullanımda lisans gerekir | BRIA RMBG-2.0 ağırlıkları (CC BY-NC) |
