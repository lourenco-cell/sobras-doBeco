// Resumo semanal doBeco → PDF → email
//
// O que faz (todas as segundas-feiras, pelo GitHub Actions):
//   1. LÊ os dados da nuvem (Firestore, só leitura, nunca escreve).
//   2. Abre o index.html do repositório num navegador invisível, SEM ligação à internet,
//      põe lá os dados e usa o próprio Resumo semanal da app (as contas são as mesmas).
//   3. Guarda o ecrã em PDF e envia-o por email, com o texto do resumo no corpo da mensagem.
//
// Ficheiro a guardar em:  automacao/resumo-semanal.js
//
// Variáveis (as 3 primeiras são "Secrets" do GitHub):
//   EMAIL_USER  conta Gmail que envia          EMAIL_PASS  palavra-passe de aplicação do Gmail
//   EMAIL_TO    quem recebe (se vazio, o EMAIL_USER)
//   Só para testes:  DRY_RUN=1 (não envia, grava em ./saida)   ROOT_JSON_FILE=ficheiro.json (não lê a nuvem)
//                    SEMANA_INICIO=AAAA-MM-DD (força uma segunda-feira)   CHROME_PATH=caminho do Chrome

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const nodemailer = require("nodemailer");

// Mesma configuração pública que a app já usa (não é segredo).
const PROJECT_ID = "dobeco-sobras";
const API_KEY = "AIzaSyBMM7z-ZTVqJcJmUSqQrOEzGXnApjQJxdo";

const DRY_RUN = process.env.DRY_RUN === "1";
const EMAIL_USER = process.env.EMAIL_USER || "";
const EMAIL_PASS = process.env.EMAIL_PASS || "";
const EMAIL_TO = process.env.EMAIL_TO || EMAIL_USER;

function falhar(msg) { console.error("ERRO: " + msg); process.exit(1); }

// ── 1) Ler a nuvem (só leitura) ──────────────────────────────────────────────
async function lerNuvem() {
  if (process.env.ROOT_JSON_FILE) {
    return { root: JSON.parse(fs.readFileSync(process.env.ROOT_JSON_FILE, "utf8")), atualizadoEm: Date.now() };
  }
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/app/root?key=${API_KEY}`;
  let res;
  try { res = await fetch(url); }
  catch (e) { throw new Error("Não consegui ligar à nuvem (sem ligação à internet?)."); }
  if (!res.ok) {
    throw new Error(`Não consegui ler a nuvem (código ${res.status}). Pode ser uma regra de segurança do Firebase ou falta de ligação.`);
  }
  const j = await res.json();
  const texto = j.fields && j.fields.data && j.fields.data.stringValue;
  if (!texto) throw new Error("O documento da nuvem está vazio.");
  const ts = j.fields.updatedAt && Number(j.fields.updatedAt.integerValue);
  return { root: JSON.parse(texto), atualizadoEm: ts || null };
}

function fmtData(iso) { const [y, m, d] = iso.split("-"); return `${d}/${m}`; }
function fmtQuando(ms) {
  if (!ms) return "desconhecido";
  return new Date(ms).toLocaleString("pt-PT", { timeZone: "Europe/Lisbon", dateStyle: "short", timeStyle: "short" });
}

(async () => {
  if (!DRY_RUN && (!EMAIL_USER || !EMAIL_PASS)) {
    falhar("Faltam os Secrets EMAIL_USER e EMAIL_PASS no GitHub (Settings → Secrets and variables → Actions).");
  }

  const { root, atualizadoEm } = await lerNuvem();
  if (!root || !root.stores) falhar("Os dados da nuvem não têm o formato esperado.");

  // ── 2) Abrir a app SEM internet e calcular o resumo com a própria lógica da app ──
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const ctx = await browser.newContext({ timezoneId: "Europe/Lisbon", locale: "pt-PT", viewport: { width: 820, height: 1100 } });
  const page = await ctx.newPage();

  // Bloqueia TODA a rede da página: assim ela nunca consegue ler nem escrever na nuvem.
  await page.route("**/*", (route) => {
    const u = route.request().url();
    if (u.startsWith("file:") || u.startsWith("data:") || u.startsWith("about:") || u.startsWith("blob:")) route.continue();
    else route.abort();
  });
  const errosPagina = [];
  page.on("pageerror", (e) => errosPagina.push(String(e.message || e)));

  const indexHtml = path.resolve(__dirname, "..", "index.html");
  if (!fs.existsSync(indexHtml)) falhar("Não encontrei o index.html na raiz do repositório.");
  await page.goto("file://" + indexHtml);
  await page.waitForFunction(() => typeof goResumo === "function" && typeof swCalcula === "function", null, { timeout: 20000 })
    .catch(() => falhar("O index.html não tem o Resumo semanal. Faz primeiro o upload da versão mais recente."));

  await page.evaluate((r) => {
    Object.keys(ROOT).forEach((k) => delete ROOT[k]);
    Object.assign(ROOT, r);
    if (!ROOT.stores) ROOT.stores = {};
    STORES.forEach((s) => { if (!ROOT.stores[s.id]) ROOT.stores[s.id] = emptyStore(); });
  }, root);

  await page.evaluate((inicio) => {
    swDesbloqueado = true;
    goResumo();
    if (inicio) { swInicio = inicio; renderResumoSemanal(); }
  }, process.env.SEMANA_INICIO || null);

  const info = await page.evaluate(() => {
    const r = swCalcula(swInicio);
    return {
      inicio: r.inicio, fim: r.fim,
      texto: swTextoResumo(r),
      faltas: swTotalFaltas(r),
      lojas: r.lojas.length,
      ecraVisivel: !document.getElementById("screen-resumo").hidden,
    };
  });
  if (!info.ecraVisivel) falhar("O ecrã do Resumo semanal não abriu.");
  if (errosPagina.length) falhar("A app deu erro ao calcular o resumo: " + errosPagina[0]);

  // ── 3) PDF do ecrã (usa o CSS de impressão da app: sem botões) ──
  const pdf = await page.pdf({
    format: "A4", printBackground: true,
    margin: { top: "14mm", bottom: "14mm", left: "12mm", right: "12mm" },
  });
  await browser.close();

  const nomePdf = `Resumo-semanal-doBeco-${info.inicio}_a_${info.fim}.pdf`;
  const periodo = `${fmtData(info.inicio)} a ${fmtData(info.fim)}`;
  const assunto = `Resumo semanal doBeco · ${periodo} · ` +
    (info.faltas ? `${info.faltas} ponto${info.faltas !== 1 ? "s" : ""} em falta` : "tudo em dia");

  const corpo =
    `Olá Lourenço,\n\n` +
    `Segue em anexo o resumo semanal (${periodo}), pronto a reencaminhar às lojas.\n` +
    `Dados da app atualizados pela última vez em ${fmtQuando(atualizadoEm)}.\n\n` +
    `────────────────────\n${info.texto}\n────────────────────\n\n` +
    `Mensagem automática. Os valores dependem do que a equipa registou na app.`;

  // ── 4) Enviar (ou, em teste, só gravar) ──
  if (DRY_RUN) {
    fs.mkdirSync("saida", { recursive: true });
    fs.writeFileSync(path.join("saida", nomePdf), pdf);
    fs.writeFileSync(path.join("saida", "corpo-do-email.txt"), `Assunto: ${assunto}\n\n${corpo}`);
    const t = nodemailer.createTransport({ jsonTransport: true });
    const r = await t.sendMail({ from: "teste@exemplo.pt", to: "teste@exemplo.pt", subject: assunto, text: corpo,
      attachments: [{ filename: nomePdf, content: pdf }] });
    console.log(`TESTE OK: PDF ${Math.round(pdf.length / 1024)} KB, anexo montado (${JSON.parse(r.message).attachments.length}), ${info.faltas} pontos em falta, ${info.lojas} lojas.`);
    return;
  }

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true,
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  });
  await transporter.sendMail({
    from: `"Resumo doBeco" <${EMAIL_USER}>`,
    to: EMAIL_TO,
    subject: assunto,
    text: corpo,
    attachments: [{ filename: nomePdf, content: pdf, contentType: "application/pdf" }],
  });
  // Nota: não imprimimos o conteúdo do relatório nos registos (o repositório é público).
  console.log(`Email enviado (${periodo}, PDF ${Math.round(pdf.length / 1024)} KB).`);
})().catch((e) => falhar(e && e.message ? e.message : String(e)));
