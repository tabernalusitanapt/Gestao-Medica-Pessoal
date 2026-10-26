"use strict";

const VAULT_NAME = "gestao-medica-pessoal";
const VAULT_VERSION = 3;
const PBKDF2_ITERATIONS = 310000;
const emptyState = () => ({ profiles: [], records: [], remindersEnabled: false, remindedRecordIds: [], calendarClientId: "" });

let vault = null;
let cryptoKey = null;
let healthData = null;
let activeProfileId = "";
let currentPage = "inicio";
let currentFilter = "Todos";
let searchTerm = "";
let reportPeriod = "Mensal";
let reportMonth = todayISO().slice(5, 7);
let reportYear = todayISO().slice(0, 4);
let selectedPhoto = "";
let selectedAttachmentType = "image";
let selectedAttachmentName = "";
let cameraStream = null;
let cameraRequestId = 0;
let toastTimer = 0;
let lockTimer = 0;
let ocrWorkerPromise = null;
let pdfJsPromise = null;

const pageNames = {
  inicio: ["O SEU ESPAÇO DE SAÚDE", "Início"],
  registos: ["CONSULTAS, EXAMES E RECEITAS", "Registos"],
  despesas: ["O SEU INVESTIMENTO NA SAÚDE", "Despesas"],
  relatorios: ["RESUMOS POR PERÍODO E TIPO", "Relatórios"],
  perfis: ["AS PESSOAS DE QUEM CUIDA", "Perfis"],
  definicoes: ["PRIVACIDADE E PREFERÊNCIAS", "Definições"]
};

const $ = selector => document.querySelector(selector);
const app = $("#app");
const lockScreen = $("#lock-screen");
const pinInput = $("#pin-input");
const pinConfirm = $("#pin-confirm");
const pinConfirmWrap = $("#pin-confirm-wrap");
const pinPrompt = $("#pin-prompt");
const pinSubmit = $("#pin-submit");
const pinError = $("#pin-error");
const pageContent = $("#page-content");
const recordDialog = $("#record-dialog");
const profileDialog = $("#profile-dialog");
const profilePinDialog = $("#profile-pin-dialog");
const profileLoginDialog = $("#profile-login-dialog");
const recordForm = $("#record-form");
const profileForm = $("#profile-form");
const profilePinForm = $("#profile-pin-form");
const profileLoginForm = $("#profile-login-form");
const photoInput = $("#record-photo");
const cameraInput = $("#record-camera");
const cameraVideo = $("#camera-video");
const photoPreview = $("#photo-preview");

profilePinDialog.addEventListener("close", () => {
  profilePinForm.reset();
  $("#profile-pin-error").textContent = "";
});
profileLoginDialog.addEventListener("close", () => {
  profileLoginForm.reset();
  $("#profile-login-error").textContent = "";
});
recordDialog.addEventListener("close", stopDocumentCamera);

function openVault() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(VAULT_NAME, VAULT_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("encryptedData")) request.result.createObjectStore("encryptedData");
      if (request.result.objectStoreNames.contains("biometricData")) request.result.deleteObjectStore("biometricData");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Não foi possível abrir o armazenamento local."));
  });
}

async function deriveProfilePinVerifier(pin, salt) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const verifier = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    material,
    256
  );
  return bytesToBase64(new Uint8Array(verifier));
}

async function getVault() {
  const db = await openVault();
  return new Promise((resolve, reject) => {
    const request = db.transaction("encryptedData", "readonly").objectStore("encryptedData").get("vault");
    request.onsuccess = () => { db.close(); resolve(request.result || null); };
    request.onerror = () => { db.close(); reject(request.error || new Error("Não foi possível ler a cópia local.")); };
  });
}

async function putVault(data) {
  const db = await openVault();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("encryptedData", "readwrite");
    transaction.objectStore("encryptedData").put(data, "vault");
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(transaction.error || new Error("Não foi possível guardar os dados neste dispositivo.")); };
    transaction.onabort = () => { db.close(); reject(transaction.error || new Error("O armazenamento local não conseguiu guardar os dados.")); };
  });
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let start = 0; start < bytes.length; start += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function deriveKey(pin, salt) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptData(data, key, salt) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(data)));
  return { version: 1, salt: bytesToBase64(salt), iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(cipher)) };
}

async function decryptData(encrypted, key) {
  if (encrypted?.version !== 1 || !encrypted.iv || !encrypted.ciphertext) throw new Error("O ficheiro não é uma cópia de segurança reconhecida.");
  const cleartext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(encrypted.iv) },
    key,
    base64ToBytes(encrypted.ciphertext)
  );
  const parsed = JSON.parse(new TextDecoder().decode(cleartext));
  if (!parsed || !Array.isArray(parsed.profiles) || !Array.isArray(parsed.records)) {
    throw new Error("A cópia não contém os registos esperados.");
  }
  parsed.profiles = parsed.profiles.map(profile => ({
    ...profile,
    address: typeof profile.address === "string" ? profile.address : "",
    locality: typeof profile.locality === "string" ? profile.locality : "",
    postalCode: typeof profile.postalCode === "string" ? profile.postalCode : "",
    city: typeof profile.city === "string" ? profile.city : "",
    accessPinSalt: typeof profile.accessPinSalt === "string" ? profile.accessPinSalt : "",
    accessPinVerifier: typeof profile.accessPinVerifier === "string" ? profile.accessPinVerifier : ""
  }));
  parsed.remindersEnabled = Boolean(parsed.remindersEnabled);
  parsed.remindedRecordIds = Array.isArray(parsed.remindedRecordIds) ? parsed.remindedRecordIds : [];
  parsed.calendarClientId = typeof parsed.calendarClientId === "string" ? parsed.calendarClientId : "";
  parsed.records = parsed.records.map(record => {
    const photo = typeof record.photo === "string" && /^data:(?:image\/[a-z0-9.+-]+|application\/pdf);base64,/i.test(record.photo)
      ? record.photo
      : "";
    const attachmentType = record.attachmentType === "pdf" && photo.startsWith("data:application/pdf;base64,")
      ? "pdf"
      : "image";
    return {
      ...record,
      photo,
      attachmentType,
      attachmentName: typeof record.attachmentName === "string" ? record.attachmentName : "",
      calendarEventId: typeof record.calendarEventId === "string" ? record.calendarEventId : ""
    };
  });
  return parsed;
}

function showPinError(message) {
  pinError.textContent = message;
  pinInput.focus();
}

function setPinMode(isSetup) {
  pinConfirmWrap.classList.toggle("hidden", !isSetup);
  pinConfirm.required = isSetup;
  pinPrompt.textContent = isSetup
    ? "Defina um PIN de 6 dígitos para proteger os seus registos."
    : "Introduza o PIN para abrir os seus registos cifrados.";
  pinSubmit.textContent = isSetup ? "Criar espaço protegido" : "Desbloquear a app";
  pinInput.autocomplete = isSetup ? "new-password" : "current-password";
  pinInput.value = "";
  pinConfirm.value = "";
  pinError.textContent = "";
}

async function initialize() {
  if (!window.crypto?.subtle || !window.indexedDB) {
    showPinError("Abra esta app num endereço HTTPS ou localhost com suporte de armazenamento seguro.");
    pinSubmit.disabled = true;
    return;
  }
  try {
    vault = await getVault();
    setPinMode(!vault);
  } catch (error) {
    console.error("Falha ao abrir o cofre local:", error);
    showPinError(`Não foi possível preparar o armazenamento: ${error.message}`);
    pinSubmit.disabled = true;
  }
}

function showApplication() {
  lockScreen.classList.add("hidden");
  app.classList.remove("hidden");
  render();
  checkReminders();
}

$("#pin-form").addEventListener("submit", async event => {
  event.preventDefault();
  const pin = pinInput.value;
  if (!/^\d{6}$/.test(pin)) return showPinError("O PIN deve ter exatamente 6 dígitos.");
  pinSubmit.disabled = true;
  pinSubmit.textContent = "A preparar o espaço…";
  pinError.textContent = "";
  try {
    if (!vault) {
      if (pin !== pinConfirm.value) return showPinError("Os PINs não coincidem. Confirme os seis dígitos.");
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const newKey = await deriveKey(pin, salt);
      const newData = emptyState();
      const newVault = await encryptData(newData, newKey, salt);
      await putVault(newVault);
      cryptoKey = newKey;
      healthData = newData;
      vault = newVault;
    } else {
      cryptoKey = await deriveKey(pin, base64ToBytes(vault.salt));
      healthData = await decryptData(vault, cryptoKey);
    }
    pinInput.value = "";
    pinConfirm.value = "";
    showApplication();
  } catch (error) {
    cryptoKey = null;
    healthData = null;
    console.error("Não foi possível desbloquear o cofre:", error);
    showPinError(vault ? "PIN incorreto ou cópia local danificada. Verifique e tente novamente." : `Não foi possível criar o espaço: ${error.message}`);
  } finally {
    pinSubmit.disabled = false;
    pinSubmit.textContent = vault ? "Desbloquear a app" : "Criar espaço protegido";
  }
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function formatDate(date) {
  if (!date) return "Sem data";
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : parseDisplayDate(date);
  if (!iso) return String(date);
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

function toStorageDate(displayDate) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(displayDate);
  if (!match) throw new Error("Introduza a data no formato DD/MM/AAAA.");
  const [, day, month, year] = match;
  const parsed = new Date(Number(year), Number(month) - 1, Number(day));
  if (parsed.getFullYear() !== Number(year) || parsed.getMonth() !== Number(month) - 1 || parsed.getDate() !== Number(day)) {
    throw new Error("A data introduzida não existe.");
  }
  return `${year}-${month}-${day}`;
}

function toDisplayDate(storageDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(storageDate || "");
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "";
}

function profileName(id) {
  return healthData.profiles.find(profile => profile.id === id)?.name || "Sem perfil associado";
}

function scopedRecords() {
  const records = activeProfileId
    ? healthData.records.filter(record => record.profileId === activeProfileId)
    : healthData.records;
  return [...records];
}

function activeProfile() {
  return activeProfileId ? healthData.profiles.find(profile => profile.id === activeProfileId) : null;
}

function visibleRecords() {
  let records = scopedRecords();
  if (currentFilter !== "Todos") records = records.filter(record => record.type === currentFilter);
  if (searchTerm) {
    const query = searchTerm.toLocaleLowerCase("pt-PT");
    records = records.filter(record =>
      `${record.title} ${record.type} ${record.notes} ${profileName(record.profileId)}`.toLocaleLowerCase("pt-PT").includes(query)
    );
  }
  return records.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

function statusClass(status) {
  if (status === "Concluído") return "done";
  if (status === "Por realizar") return "pending";
  return "";
}

function recordSymbol(type) {
  return ({ Consulta: "♙", Exame: "⌕", Análise: "＋", Receita: "℞", Medicamento: "＋", Despesa: "€" })[type] || "•";
}

function renderUpcoming(record) {
  const date = new Date(`${record.date}T12:00:00`);
  const person = profileName(record.profileId);
  return `<div class="upcoming-row" data-record="${escapeHtml(record.id)}">
    <div class="date-tile"><b>${date.getDate()}</b><span>${escapeHtml(new Intl.DateTimeFormat("pt-PT", { month: "short" }).format(date).replace(".", ""))}</span></div>
    <div class="row-main"><p class="row-title">${escapeHtml(record.title)}</p><p class="row-meta">${escapeHtml(record.type)} · ${escapeHtml(person)} · ${formatDate(record.date)}${record.time ? ` · ${escapeHtml(record.time)}` : ""}</p></div>
    <span class="status ${statusClass(record.status)}">${escapeHtml(record.status)}</span><span class="record-chevron">›</span>
  </div>`;
}

function recordListRow(record) {
  const image = record.photo && record.attachmentType !== "pdf"
    ? `<img class="record-photo-thumb" src="${record.photo}" alt="Documento anexado">`
    : record.photo
      ? `<span class="type-dot pdf-dot" aria-label="Documento PDF">PDF</span>`
    : `<span class="type-dot">${recordSymbol(record.type)}</span>`;
  const cost = Number(record.cost) > 0 ? `<span class="row-cost">${money(record.cost)}</span>` : "";
  return `<div class="record-row" data-record="${escapeHtml(record.id)}">
    ${image}    <div class="row-main"><p class="row-title">${escapeHtml(record.title)}</p><p class="row-meta">${escapeHtml(record.type)} · ${escapeHtml(profileName(record.profileId))} · ${formatDate(record.date)}</p></div>
    ${cost}<span class="status ${statusClass(record.status)}">${escapeHtml(record.status)}</span><span class="record-chevron">›</span>
  </div>`;
}

function money(value) {
  return new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(Number(value) || 0);
}

function renderHome() {
  const records = scopedRecords();
  const profile = activeProfile();
  const today = todayISO();
  const pending = records.filter(record =>
    record.date >= today && (record.status === "Agendado" || record.status === "Por realizar")
  ).sort((a, b) => `${a.date}${a.time || ""}`.localeCompare(`${b.date}${b.time || ""}`));
  const thisMonth = today.slice(0, 7);
  const spent = records
    .filter(record => record.date?.startsWith(thisMonth))
    .reduce((total, record) => total + (Number(record.cost) || 0), 0);
  const upcomingHTML = pending.length
    ? pending.slice(0, 5).map(renderUpcoming).join("")
    : `<div class="empty-state"><strong>Um espaço para respirar.</strong><p>Não há consultas ou exames futuros registados.<br>Adicione uma marcação para começar a acompanhar a sua agenda.</p><button class="button button-primary" data-action="new-record">＋ Adicionar registo</button></div>`;

  pageContent.innerHTML = `
    <section class="welcome-card">
      <div class="welcome-copy"><p class="eyebrow">${profile ? "O SEU PERFIL" : "TUDO NO SEU TEMPO"}</p><h2>${profile ? `Olá, ${escapeHtml(profile.name.split(" ")[0])}.` : healthData.profiles.length ? `Olá, ${escapeHtml(healthData.profiles[0].name.split(" ")[0])}.` : "A sua saúde, organizada."}</h2><p>Consultas, exames e documentos importantes, reunidos num só lugar.</p></div>
      <div class="welcome-decoration"><img src="./app-icon.svg" alt=""></div>
    </section>
    <section class="stat-grid" aria-label="Resumo">
      <div class="stat-card"><span class="stat-icon">▤</span><div><div class="stat-value">${records.length}</div><div class="stat-label">Registos totais</div></div></div>
      <div class="stat-card"><span class="stat-icon amber">◷</span><div><div class="stat-value">${pending.length}</div><div class="stat-label">Acompanhamentos futuros</div></div></div>
      <div class="stat-card"><span class="stat-icon coral">€</span><div><div class="stat-value">${money(spent)}</div><div class="stat-label">Despesas este mês</div></div></div>
    </section>
    <div class="section-heading"><h2>O que se aproxima</h2><button class="text-button" data-page="registos">Ver todos</button></div>
    <section class="panel upcoming-list">${upcomingHTML}</section>
    <div class="section-heading"><h2>Acesso rápido</h2></div>
    <section class="quick-grid">
      <button class="quick-card" data-action="new-record" data-type="Consulta"><span class="stat-icon">♙</span><span>Registar consulta</span></button>
      <button class="quick-card" data-action="new-record" data-type="Exame"><span class="stat-icon amber">⌕</span><span>Registar exame</span></button>
      <button class="quick-card" data-action="new-record" data-type="Receita"><span class="stat-icon coral">℞</span><span>Guardar receita</span></button>
    </section>`;
}

function renderRecords() {
  const filters = ["Todos", "Consulta", "Exame", "Análise", "Receita", "Medicamento", "Despesa"];
  const records = visibleRecords();
  const list = records.length
    ? records.map(recordListRow).join("")
    : `<div class="empty-state"><strong>${scopedRecords().length ? "Não encontrámos registos." : "Comece pelo que é importante."}</strong><p>${scopedRecords().length ? "Experimente outro filtro ou termo de pesquisa." : "Guarde uma consulta, exame ou receita e tenha o documento sempre à mão."}</p>${scopedRecords().length ? "" : '<button class="button button-primary" data-action="new-record">＋ Criar primeiro registo</button>'}</div>`;
  pageContent.innerHTML = `<div class="toolbar"><div class="filter-tabs">${filters.map(filter => `<button class="filter-tab ${currentFilter === filter ? "active" : ""}" data-filter="${filter}">${filter}</button>`).join("")}</div><input class="search-box" type="search" aria-label="Pesquisar registos" placeholder="Pesquisar registos…" value="${escapeHtml(searchTerm)}"></div><section class="panel record-list">${list}</section>`;
}

function renderExpenses() {
  const expenses = scopedRecords()
    .filter(record => Number(record.cost) > 0 || record.type === "Despesa")
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const thisMonth = todayISO().slice(0, 7);
  const monthTotal = expenses.filter(record => record.date?.startsWith(thisMonth)).reduce((sum, record) => sum + Number(record.cost), 0);
  const allTotal = expenses.reduce((sum, record) => sum + Number(record.cost), 0);
  const list = expenses.length ? expenses.map(recordListRow).join("") : `<div class="empty-state"><strong>Ainda sem despesas registadas.</strong><p>Adicione o valor de uma receita, medicamento, consulta, exame ou despesa.</p><button class="button button-primary" data-action="new-record" data-type="Despesa">＋ Adicionar despesa</button></div>`;
  pageContent.innerHTML = `<section class="summary-banner"><div><p>Total de despesas registadas</p><strong>${money(allTotal)}</strong><p class="expense-month">Este mês: ${money(monthTotal)}</p></div><span class="stat-icon coral">€</span></section><div class="section-heading"><h2>Despesas de saúde</h2><span class="row-meta">${expenses.length} ${expenses.length === 1 ? "registo" : "registos"}</span></div><section class="panel record-list">${list}</section><div class="section-heading"><h2>Relatórios detalhados</h2><button class="text-button" data-page="relatorios">Ver relatórios</button></div>`;
}

function reportRange(referenceMonth, period) {
  const [year, month] = referenceMonth.split("-").map(Number);
  const periodMonths = { Mensal: 1, Trimestral: 3, Semestral: 6, Anual: 12 }[period] || 1;
  const firstMonth = Math.floor((month - 1) / periodMonths) * periodMonths;
  const start = new Date(year, firstMonth, 1);
  const end = new Date(year, firstMonth + periodMonths, 0);
  const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const label = period === "Mensal"
    ? new Intl.DateTimeFormat("pt-PT", { month: "long", year: "numeric" }).format(start)
    : `${formatDate(iso(start))} — ${formatDate(iso(end))}`;
  return { start: iso(start), end: iso(end), label };
}

function renderReports(nextPeriod = reportPeriod) {
  const existingMonth = $("#report-month")?.value;
  const existingYear = $("#report-year")?.value;
  if (existingMonth) reportMonth = existingMonth;
  if (existingYear) reportYear = existingYear;
  reportPeriod = nextPeriod;
  const period = reportPeriod;
  const referenceMonth = `${reportYear}-${reportMonth}`;
  const range = reportRange(referenceMonth, period);
  const matchesPeriod = record => record.date >= range.start && record.date <= range.end;
  const reportsRecords = scopedRecords();
  const consultations = reportsRecords.filter(record => record.type === "Consulta" && matchesPeriod(record))
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const consultationTotal = consultations.reduce((total, record) => total + (Number(record.cost) || 0), 0);
  const completedByType = type => reportsRecords.filter(record =>
    record.type === type && record.status === "Concluído" && matchesPeriod(record)
  );
  const exams = completedByType("Exame");
  const analyses = completedByType("Análise");
  const reportForCompletedRecords = (records, singular) => {
    const groups = new Map();
    for (const record of records) {
      const name = record.title.trim() || `${singular} sem nome`;
      const key = name.toLocaleLowerCase("pt-PT");
      const summary = groups.get(key) || { name, total: 0, count: 0 };
      summary.total += Number(record.cost) || 0;
      summary.count += 1;
      groups.set(key, summary);
    }
    const rows = groups.size
      ? [...groups.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "pt-PT")).map(summary =>
        `<div class="report-row"><span class="row-title">${escapeHtml(summary.name)}</span><span class="row-meta">${summary.count} ${summary.count === 1 ? singular.toLocaleLowerCase("pt-PT") : `${singular.toLocaleLowerCase("pt-PT")}s`}</span><strong class="row-cost">${money(summary.total)}</strong></div>`
      ).join("")
      : `<div class="empty-state"><strong>Sem ${singular.toLocaleLowerCase("pt-PT")} realizados neste período.</strong><p>Os registos marcados como concluídos aparecerão aqui com o tipo e custo.</p></div>`;
    return {
      count: records.length,
      total: records.reduce((total, record) => total + (Number(record.cost) || 0), 0),
      rows
    };
  };
  const examReport = reportForCompletedRecords(exams, "Exame");
  const analysisReport = reportForCompletedRecords(analyses, "Análise");
  const medicationCosts = reportsRecords.filter(record =>
    record.type === "Medicamento" && Number(record.cost) > 0 && matchesPeriod(record)
  );
  const medicationGroups = new Map();
  for (const record of medicationCosts) {
    const name = record.title.trim() || "Medicamento sem nome";
    const key = name.toLocaleLowerCase("pt-PT");
    const summary = medicationGroups.get(key) || { name, total: 0, count: 0 };
    summary.total += Number(record.cost);
    summary.count += 1;
    medicationGroups.set(key, summary);
  }
  const medicationTotal = medicationCosts.reduce((total, record) => total + Number(record.cost), 0);
  const medicationList = medicationGroups.size
    ? [...medicationGroups.values()].sort((a, b) => b.total - a.total).map(summary =>
      `<div class="report-row"><span class="row-title">${escapeHtml(summary.name)}</span><span class="row-meta">${summary.count} ${summary.count === 1 ? "compra" : "compras"}</span><strong class="row-cost">${money(summary.total)}</strong></div>`
    ).join("")
    : `<div class="empty-state"><strong>Sem despesas com medicamentos.</strong><p>Registe o nome do fármaco e o valor no tipo “Medicamento” para o incluir aqui.</p></div>`;
  const consultationList = consultations.length
    ? consultations.map(record => `<div class="report-row"><div class="row-main"><p class="row-title">${escapeHtml(record.title)}</p><p class="row-meta">${escapeHtml(formatDate(record.date))} · ${escapeHtml(profileName(record.profileId))} · ${escapeHtml(record.status)}</p></div><strong class="row-cost">${money(record.cost)}</strong></div>`).join("")
    : `<div class="empty-state"><strong>Sem consultas neste período.</strong><p>As consultas registadas aparecerão aqui com a respetiva data e custo.</p></div>`;
  const yearOptions = new Set();
  const currentYear = new Date().getFullYear();
  for (let year = currentYear - 10; year <= currentYear + 5; year += 1) yearOptions.add(String(year));
  for (const record of reportsRecords) {
    const year = /^\d{4}-\d{2}-\d{2}$/.test(record.date || "") ? record.date.slice(0, 4) : "";
    if (year) yearOptions.add(year);
  }
  const months = Array.from({ length: 12 }, (_, index) => {
    const value = String(index + 1).padStart(2, "0");
    const label = new Intl.DateTimeFormat("pt-PT", { month: "long" }).format(new Date(2024, index, 1));
    return `<option value="${value}" ${value === reportMonth ? "selected" : ""}>${label}</option>`;
  }).join("");
  const years = [...yearOptions].sort((a, b) => Number(b) - Number(a)).map(year =>
    `<option value="${year}" ${year === reportYear ? "selected" : ""}>${year}</option>`
  ).join("");
  pageContent.innerHTML = `
    <div class="toolbar report-toolbar">
      <div class="filter-tabs" aria-label="Período do relatório">
        ${["Mensal", "Trimestral", "Semestral", "Anual"].map(item => `<button type="button" class="filter-tab ${period === item ? "active" : ""}" data-report-period="${item}">${item}</button>`).join("")}
      </div>
      <div class="report-period-picker"><span class="report-month-label">Escolher período</span><div class="report-period-selectors"><label class="visually-hidden" for="report-month">Mês</label><select id="report-month" aria-label="Mês">${months}</select><label class="visually-hidden" for="report-year">Ano</label><select id="report-year" aria-label="Ano">${years}</select></div></div>
    </div>
    <p class="report-range-label">${escapeHtml(range.label)}</p>
    <section class="report-grid">
      <article class="panel report-card"><div class="report-card-heading"><div><p class="eyebrow">FARMÁCIA</p><h2>Despesas com medicação</h2></div><span class="stat-icon coral">€</span></div><strong class="report-total">${money(medicationTotal)}</strong><p class="row-meta">${medicationCosts.length} ${medicationCosts.length === 1 ? "compra de medicamentos" : "compras de medicamentos"} no período</p><div class="report-rows">${medicationList}</div></article>
      <article class="panel report-card"><div class="report-card-heading"><div><p class="eyebrow">CONSULTAS</p><h2>Consultas registadas</h2></div><span class="stat-icon amber">♙</span></div><strong class="report-total">${consultations.length}</strong><p class="row-meta">Custo total: ${money(consultationTotal)}</p><div class="report-rows">${consultationList}</div></article>
      <article class="panel report-card"><div class="report-card-heading"><div><p class="eyebrow">EXAMES</p><h2>Exames realizados</h2></div><span class="stat-icon amber">⌕</span></div><strong class="report-total">${examReport.count}</strong><p class="row-meta">Custo total: ${money(examReport.total)}</p><div class="report-rows">${examReport.rows}</div></article>
      <article class="panel report-card"><div class="report-card-heading"><div><p class="eyebrow">ANÁLISES</p><h2>Análises realizadas</h2></div><span class="stat-icon">＋</span></div><strong class="report-total">${analysisReport.count}</strong><p class="row-meta">Custo total: ${money(analysisReport.total)}</p><div class="report-rows">${analysisReport.rows}</div></article>
    </section>`;
}

function renderProfiles() {
  const profiles = (activeProfile() ? [activeProfile()] : healthData.profiles).map(profile => {
    const recordCount = healthData.records.filter(record => record.profileId === profile.id).length;
    const detail = (label, value) => `<div><span class="detail-label">${label}</span><span class="detail-value">${value ? escapeHtml(value) : "—"}</span></div>`;
    const controls = activeProfileId
      ? `<button class="button button-light" data-action="edit-profile" data-id="${escapeHtml(profile.id)}">Corrigir os meus dados</button>`
      : `<button class="button button-light" data-action="edit-profile" data-id="${escapeHtml(profile.id)}">Editar perfil</button><button class="button button-light" data-action="set-profile-pin" data-id="${escapeHtml(profile.id)}">${profile.accessPinVerifier ? "Alterar PIN de acesso" : "Definir PIN de acesso"}</button>`;
    return `<article class="panel profile-card"><div class="profile-header"><span class="profile-avatar">${escapeHtml(profile.name.charAt(0).toUpperCase())}</span><div><h3>${escapeHtml(profile.name)}</h3><p>${recordCount} ${recordCount === 1 ? "registo" : "registos"} de saúde</p></div></div><div class="profile-details">${detail("Telefone", profile.phone)}${detail("Email", profile.email)}${detail("Morada", profile.address)}${detail("Localidade", profile.locality)}${detail("Código Postal", profile.postalCode)}${detail("Cidade", profile.city)}${detail("N.º de utente", profile.healthNumber)}${detail("Segurança Social", profile.socialNumber)}</div><div class="settings-actions" style="margin-top:14px">${controls}</div></article>`;
  }).join("");
  if (activeProfileId) {
    pageContent.innerHTML = `<div class="toolbar"><p class="row-meta">Este é o perfil ao qual está a aceder nesta sessão.</p></div><section class="profile-grid">${profiles}</section>`;
    return;
  }
  pageContent.innerHTML = `<div class="toolbar"><p class="row-meta">${healthData.profiles.length ? "Os dados de cada pessoa acompanham os seus registos. Defina um PIN para permitir acesso individual durante uma sessão aberta pelo responsável." : "Adicione perfis para organizar os cuidados da família."}</p><button class="button button-primary" data-action="new-profile">＋ Adicionar perfil</button></div>${profiles.length ? `<section class="profile-grid">${profiles}</section>` : `<section class="panel empty-state"><strong>Perfis para toda a família.</strong><p>Nome, contacto e identificadores de saúde são opcionais. Adicione apenas o que precisa.</p><button class="button button-primary" data-action="new-profile">＋ Adicionar perfil</button></section>`}`;
}

function renderSettings() {
  if (activeProfileId) {
    const profile = activeProfile();
    pageContent.innerHTML = `<div class="settings-stack"><section class="panel settings-card"><h2>Sessão de ${escapeHtml(profile.name)}</h2><p>Está a consultar a app com o acesso deste perfil. Para sair, volte ao ecrã de bloqueio; o responsável terá de introduzir o PIN mestre para abrir a sessão seguinte.</p><div class="settings-actions"><button class="button button-light" data-action="end-profile-session">Terminar acesso do perfil</button></div><div class="security-callout">Este acesso limita os ecrãs da app, mas não cria uma barreira criptográfica entre perfis. Use-o apenas num dispositivo de confiança e depois de o responsável abrir o cofre com o PIN mestre.</div></section></div>`;
    return;
  }
  const reminderEnabled = healthData.remindersEnabled ? "Desativar notificações neste dispositivo" : "Ativar notificações neste dispositivo";
  pageContent.innerHTML = `
    <div class="settings-stack">
      <section class="panel settings-card"><h2>Cópias de segurança cifradas</h2><p>Exporte um ficheiro protegido pelo seu PIN e guarde-o manualmente no Google Drive. A app não acede à sua conta Google nem envia os seus dados para a cloud.</p><div class="settings-actions"><button class="button button-primary" data-action="export-backup">⇧ Exportar cópia cifrada</button><button class="button button-light" data-action="import-backup">↧ Importar cópia</button><a class="button button-light" href="https://drive.google.com/drive/my-drive" target="_blank" rel="noopener noreferrer">Abrir Google Drive ↗</a><input id="backup-file" class="visually-hidden" type="file" accept="application/json,.json"></div><div class="security-callout">O PIN de 6 dígitos é a única chave. Se o esquecer, nem o Google Drive poderá recuperar os dados. Um PIN curto é mais fraco contra tentativas sobre um ficheiro roubado; mantenha o ficheiro privado e escolha um PIN difícil de adivinhar.</div></section>
      <section class="panel settings-card"><h2>Acesso dos perfis</h2><p>Defina um PIN para cada familiar na página <strong>Perfis</strong>. O responsável abre primeiro a app com o PIN mestre; depois, a pessoa escolhe o próprio perfil e introduz o respetivo PIN.</p><div class="settings-actions"><button class="button button-primary" data-action="profile-login">Passar acesso a um perfil</button></div><div class="security-callout">O acesso individual restringe o que aparece na interface, mas não cifra os dados separadamente. Não equivale a autenticação biométrica nem a uma barreira técnica contra alguém que inspecione o dispositivo.</div></section>
      <section class="panel settings-card"><h2>Google Calendar</h2><p>Guarde os eventos diretamente no seu calendário, sem ter de preencher um modelo. Crie um ID de cliente OAuth para aplicação Web na Google Cloud Console e autorize o endereço HTTPS desta app. Não introduza a palavra-passe Google aqui.</p><label for="google-client-id">ID de cliente OAuth</label><input id="google-client-id" class="settings-input" value="${escapeHtml(healthData.calendarClientId || "")}" placeholder="…apps.googleusercontent.com" autocomplete="off"><div class="settings-actions" style="margin-top:10px"><button class="button button-light" data-action="save-google-client">Guardar ID do cliente</button></div><div class="security-callout">Na primeira marcação, a Google pedirá autorização para criar eventos. Serão enviados ao Google Calendar o título, o tipo, a data/hora, o perfil e as notas desse evento. A ligação requer internet. A app guarda apenas o ID público; o token de acesso fica apenas em memória.</div></section>
      <section class="panel settings-card"><h2>Lembretes</h2><p>As notificações só podem ser entregues de forma fiável quando a app está aberta.</p><div class="settings-actions"><button class="button button-light" data-action="toggle-reminders">${reminderEnabled}</button></div></section>
      <section class="panel settings-card"><h2>Os seus dados</h2><p>${healthData.profiles.length} ${healthData.profiles.length === 1 ? "perfil" : "perfis"} e ${healthData.records.length} ${healthData.records.length === 1 ? "registo" : "registos"} cifrados neste dispositivo.</p><ul class="settings-list"><li>O cofre local é cifrado com AES-GCM e uma chave derivada do PIN.</li><li>As cópias exportadas permanecem cifradas; não existe recuperação sem o PIN.</li><li>Bloqueie a app quando terminar de usar este dispositivo partilhado.</li></ul><div class="settings-actions" style="margin-top:14px"><button class="button button-light" data-action="lock">Bloquear agora</button></div></section>
    </div>`;
}

function render() {
  if (!healthData) return;
  const [eyebrow, title] = pageNames[currentPage] || pageNames.inicio;
  $("#page-eyebrow").textContent = eyebrow;
  $("#page-title").textContent = title;
  const avatar = (activeProfile()?.name || healthData.profiles[0]?.name || "").trim().charAt(0).toUpperCase() || "?";
  $(".avatar-button").textContent = avatar;
  document.querySelectorAll("[data-page]").forEach(button => {
    button.classList.toggle("active", button.dataset.page === currentPage);
  });
  if (currentPage === "inicio") renderHome();
  else if (currentPage === "registos") renderRecords();
  else if (currentPage === "despesas") renderExpenses();
  else if (currentPage === "relatorios") renderReports();
  else if (currentPage === "perfis") renderProfiles();
  else renderSettings();
}

async function persist() {
  if (!healthData || !cryptoKey || !vault) throw new Error("O espaço está bloqueado. Desbloqueie-o antes de guardar alterações.");
  const nextVault = await encryptData(healthData, cryptoKey, base64ToBytes(vault.salt));
  await putVault(nextVault);
  vault = nextVault;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => element.classList.remove("visible"), 3500);
}

function profileOptions(selectedId = "") {
  return `<option value="">Sem perfil associado</option>${healthData.profiles.map(profile => `<option value="${escapeHtml(profile.id)}" ${profile.id === selectedId ? "selected" : ""}>${escapeHtml(profile.name)}</option>`).join("")}`;
}

function updatePhotoPreview(photo, type = "image", name = "") {
  stopDocumentCamera();
  selectedPhoto = photo;
  selectedAttachmentType = photo ? type : "image";
  selectedAttachmentName = photo ? name : "";
  $("#photo-preview-wrap").classList.toggle("hidden", !photo);
  $("#ocr-button").classList.toggle("hidden", !photo);
  $("#ocr-button").disabled = false;
  $("#photo-label").innerHTML = photo
    ? `${type === "pdf" ? "PDF anexado" : "Imagem anexada"}<small>Toque para escolher outro documento</small>`
    : "Escolher imagem ou PDF<small>Documento guardado apenas neste dispositivo</small>";
  photoPreview.classList.toggle("hidden", type === "pdf");
  photoPreview.src = type === "image" ? photo : "";
  const pdfPreview = $("#pdf-preview-wrap");
  pdfPreview.classList.toggle("hidden", !photo || type !== "pdf");
  if (photo && type === "pdf") {
    $("#pdf-preview").src = photo;
    $("#pdf-download").href = photo;
    $("#pdf-download").download = name || "documento.pdf";
    $("#pdf-name").textContent = name || "documento.pdf";
  } else {
    $("#pdf-preview").removeAttribute("src");
    $("#pdf-download").removeAttribute("href");
  }
  if (!photo) $("#ocr-status").textContent = "";
}

function stopDocumentCamera() {
  cameraRequestId += 1;
  if (cameraStream) {
    for (const track of cameraStream.getTracks()) track.stop();
    cameraStream = null;
  }
  cameraVideo.srcObject = null;
  $("#camera-panel").classList.add("hidden");
}

async function startDocumentCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    const message = window.isSecureContext
      ? "Este navegador não disponibiliza acesso direto à câmara. Pode usar a câmara do dispositivo ou escolher uma imagem."
      : "Para usar a câmara diretamente, abra a app através de HTTPS ou de localhost. Também pode escolher uma imagem.";
    $("#ocr-status").textContent = message;
    toast(message);
    cameraInput.click();
    return;
  }

  stopDocumentCamera();
  const requestId = cameraRequestId;
  $("#camera-video").classList.remove("hidden");
  $("#native-camera-button").classList.add("hidden");
  $("#camera-panel").classList.remove("hidden");
  $("#ocr-status").textContent = "A aguardar autorização do navegador para usar a câmara…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    });
    if (requestId !== cameraRequestId || !recordDialog.open) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    cameraStream = stream;
    cameraVideo.srcObject = cameraStream;
    $("#ocr-status").textContent = "A câmara está ativa. Enquadre o documento e tire a fotografia.";
    await cameraVideo.play();
  } catch (error) {
    if (requestId !== cameraRequestId || !recordDialog.open) return;
    stopDocumentCamera();
    console.error("Falha ao abrir a webcam:", error);
    const messages = {
      NotAllowedError: "O acesso à câmara foi recusado. Autorize a câmara nas permissões do navegador ou use a câmara do dispositivo.",
      NotFoundError: "Não foi encontrada uma câmara neste dispositivo. Pode escolher uma imagem.",
      NotReadableError: "A câmara está ocupada por outra aplicação. Feche-a e tente novamente ou use a câmara do dispositivo.",
      OverconstrainedError: "A câmara não consegue usar as definições pedidas. Tente usar a câmara do dispositivo.",
      SecurityError: "O navegador bloqueou a câmara. Abra a app através de HTTPS ou de localhost."
    };
    const message = messages[error.name] || `Não foi possível abrir a webcam: ${error.message || error.name}`;
    $("#camera-video").classList.add("hidden");
    $("#native-camera-button").classList.remove("hidden");
    $("#camera-panel").classList.remove("hidden");
    $("#ocr-status").textContent = message;
    toast(message);
  }
}

function captureDocumentPhoto() {
  if (!cameraStream || cameraVideo.videoWidth === 0 || cameraVideo.videoHeight === 0) {
    toast("A webcam ainda não está pronta. Aguarde a imagem e tente novamente.");
    return;
  }
  const scale = Math.min(1, 1500 / Math.max(cameraVideo.videoWidth, cameraVideo.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(cameraVideo.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(cameraVideo.videoHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    toast("Este dispositivo não suporta a captura da webcam.");
    return;
  }
  context.drawImage(cameraVideo, 0, 0, canvas.width, canvas.height);
  updatePhotoPreview(canvas.toDataURL("image/jpeg", 0.76), "image", "Fotografia da webcam");
  $("#ocr-status").textContent = "Fotografia pronta. Escolha «Ler documento e preencher dados» para sugerir os campos.";
  stopDocumentCamera();
}

function openRecordForm(record = null, type = "") {
  stopDocumentCamera();
  recordForm.reset();
  selectedPhoto = record?.photo || "";
  selectedAttachmentType = record?.attachmentType || (selectedPhoto.startsWith("data:application/pdf;") ? "pdf" : "image");
  selectedAttachmentName = record?.attachmentName || "";
  $("#record-dialog-title").textContent = record ? "Editar registo" : "Novo registo";
  $("#record-title").value = record?.title || "";
  $("#record-type").value = record?.type || type || "Consulta";
  $("#record-title").dataset.userSelectedType = record || type ? "true" : "";
  updateRecordTitleLabel();
  $("#record-status").value = record?.status || ((type || record?.type) === "Despesa" ? "Concluído" : "Agendado");
  $("#record-date").value = toDisplayDate(record?.date || todayISO());
  $("#record-time").value = record?.time || "";
  $("#record-profile").innerHTML = profileOptions(record?.profileId || "");
  $("#record-profile").disabled = Boolean(activeProfileId);
  if (activeProfileId) $("#record-profile").value = activeProfileId;
  $("#record-cost").value = record?.cost || "";
  $("#record-notes").value = record?.notes || "";
  recordForm.dataset.editId = record?.id || "";
  photoInput.value = "";
  cameraInput.value = "";
  updatePhotoPreview(selectedPhoto, selectedAttachmentType, selectedAttachmentName);
  $("#ocr-status").textContent = "";
  recordDialog.showModal();
}

function updateRecordTitleLabel() {
  const type = $("#record-type").value;
  $("#record-title-label").textContent = type === "Medicamento" ? "Nome do fármaco *" : type === "Despesa" ? "Descrição da despesa *" : "Nome do registo *";
  $("#record-title").placeholder = type === "Medicamento" ? "Ex.: nome do medicamento" : type === "Despesa" ? "Ex.: pagamento de consulta" : "Ex.: Consulta de cardiologia";
}

function openProfileForm(profile = null) {
  profileForm.reset();
  $("#profile-dialog-title").textContent = profile ? "Editar perfil" : "Novo perfil";
  $("#profile-name").value = profile?.name || "";
  $("#profile-phone").value = profile?.phone || "";
  $("#profile-email").value = profile?.email || "";
  $("#profile-address").value = profile?.address || "";
  $("#profile-locality").value = profile?.locality || "";
  $("#profile-postal-code").value = profile?.postalCode || "";
  $("#profile-city").value = profile?.city || "";
  $("#profile-health-number").value = profile?.healthNumber || "";
  $("#profile-social-number").value = profile?.socialNumber || "";
  profileForm.dataset.editId = profile?.id || "";
  profileDialog.showModal();
}

function openProfilePinForm(profileId) {
  const profiles = activeProfileId ? [activeProfile()] : healthData.profiles;
  const eligibleProfiles = profiles.filter(Boolean);
  $("#profile-pin-target").innerHTML = eligibleProfiles.map(profile =>
    `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`
  ).join("");
  $("#profile-pin-target").value = profileId || eligibleProfiles[0]?.id || "";
  profilePinForm.reset();
  $("#profile-pin-target").value = profileId || eligibleProfiles[0]?.id || "";
  $("#profile-pin-error").textContent = "";
  profilePinDialog.showModal();
}

function openProfileLoginForm() {
  const profiles = healthData.profiles.filter(profile => profile.accessPinSalt && profile.accessPinVerifier);
  if (!profiles.length) {
    toast("Defina primeiro um PIN de acesso na página Perfis.");
    return;
  }
  $("#profile-login-target").innerHTML = profiles.map(profile =>
    `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`
  ).join("");
  profileLoginForm.reset();
  $("#profile-login-pin").value = "";
  $("#profile-login-error").textContent = "";
  profileLoginDialog.showModal();
}

async function compressImage(file) {
  if (!file.type.startsWith("image/")) throw new Error("Escolha um ficheiro de imagem.");
  if (file.size > 20 * 1024 * 1024) throw new Error("A imagem deve ter menos de 20 MB.");
  const original = await new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Não foi possível abrir esta imagem.")); };
    image.src = url;
  });
  const scale = Math.min(1, 1500 / Math.max(original.naturalWidth, original.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(original.naturalWidth * scale);
  canvas.height = Math.round(original.naturalHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("O dispositivo não suporta tratamento de imagem.");
  context.drawImage(original, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.76);
}

async function readPdfFile(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error("O PDF deve ter menos de 20 MB.");
  const header = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (new TextDecoder().decode(header) !== "%PDF-") throw new Error("O ficheiro selecionado não parece ser um PDF válido.");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Não foi possível ler o PDF."));
    reader.onerror = () => reject(reader.error || new Error("Não foi possível ler o PDF."));
    reader.readAsDataURL(file);
  });
}

async function handleAttachmentChange(input) {
  const file = input.files?.[0];
  if (!file) return;
  try {
    const isPdf = file.type === "application/pdf" || file.name.toLocaleLowerCase("pt-PT").endsWith(".pdf");
    if (isPdf) {
      updatePhotoPreview(await readPdfFile(file), "pdf", file.name);
      $("#ocr-status").textContent = "PDF pronto. A leitura local analisará a primeira página.";
    } else {
      updatePhotoPreview(await compressImage(file), "image", file.name);
      $("#ocr-status").textContent = "Imagem pronta. Leia o documento para preencher sugestões automaticamente.";
    }
  } catch (error) {
    console.error("Falha ao preparar documento:", error);
    toast(error.message);
  } finally {
    input.value = "";
  }
}

for (const input of [photoInput, cameraInput]) {
  input.addEventListener("change", () => handleAttachmentChange(input));
}

function guessDocumentDetails(text) {
  const lines = text.split(/\r?\n/).map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const searchableText = text.toLocaleLowerCase("pt-PT");
  let type = "";
  if (/\b(receita|prescri[cç][aã]o|prescrito|medica[cç][aã]o)\b/i.test(searchableText)) type = "Receita";
  else if (/\b(despesa|fatura|recibo|tal[aã]o|comprovativo de pagamento)\b/i.test(searchableText)) type = "Despesa";
  else if (/\b(exame|ecografia|radiografia|resson[aâ]ncia|tomografia|mamografia|eletrocardiograma)\b/i.test(searchableText)) type = "Exame";
  else if (/\b(an[aá]lise|an[aá]lises|laborat[oó]rio|sangue|urina)\b/i.test(searchableText)) type = "Análise";
  else if (/\b(consulta|marca[cç][aã]o|especialidade|m[eé]dico|m[eé]dica)\b/i.test(searchableText)) type = "Consulta";

  const dateCandidates = [
    ...text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g),
    ...text.matchAll(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/g)
  ];
  let date = "";
  for (const match of dateCandidates) {
    const displayDate = /^\d{4}$/.test(match[1])
      ? `${match[3]}/${match[2]}/${match[1]}`
      : `${match[1].padStart(2, "0")}/${match[2].padStart(2, "0")}/${match[3]}`;
    try {
      date = toStorageDate(displayDate);
      break;
    } catch {
      continue;
    }
  }

  const title = lines.find(line =>
    line.length >= 4 &&
    line.length <= 90 &&
    !/^\d[\d\s./:-]*$/.test(line) &&
    !/\b(utente|seguran[cç]a social|nif|morada|data de nascimento)\b/i.test(line)
  ) || "";
  return { type, date, title };
}

async function getOcrWorker(status) {
  if (!window.Tesseract?.createWorker) {
    throw new Error("O motor de leitura não está disponível. Recarregue a app quando tiver ligação.");
  }
  if (!ocrWorkerPromise) {
    const baseUrl = new URL("./assets/ocr/", window.location.href);
    ocrWorkerPromise = window.Tesseract.createWorker("por", 1, {
      workerPath: new URL("worker.min.js", baseUrl).href,
      corePath: new URL("core/tesseract-core-lstm.wasm.js", baseUrl).href,
      langPath: new URL("lang/", baseUrl).href,
      gzip: false,
      logger: message => {
        if (message.status && message.progress != null) {
          status.textContent = `A ler o documento em português: ${Math.round(message.progress * 100)}%`;
        } else if (message.status) {
          status.textContent = `${message.status}…`;
        }
      }
    }).catch(error => {
      ocrWorkerPromise = null;
      throw error;
    });
  }
  return ocrWorkerPromise;
}

async function readDocument() {
  if (!selectedPhoto) return toast("Fotografe ou anexe primeiro um documento.");
  const button = $("#ocr-button");
  const status = $("#ocr-status");
  button.disabled = true;
  status.textContent = "A iniciar a leitura local…";
  try {
    let text;
    let worker;
    if (selectedAttachmentType === "pdf") {
      if (!pdfJsPromise) {
        pdfJsPromise = import(new URL("./assets/pdf/pdf.min.mjs", window.location.href).href).then(pdfjs => {
          pdfjs.GlobalWorkerOptions.workerSrc = new URL("./assets/pdf/pdf.worker.min.mjs", window.location.href).href;
          return pdfjs;
        }).catch(error => {
          pdfJsPromise = null;
          throw error;
        });
      }
      status.textContent = "A abrir o PDF localmente…";
      const pdfjs = await pdfJsPromise;
      const pdfData = base64ToBytes(selectedPhoto.slice(selectedPhoto.indexOf(",") + 1));
      const pdf = await pdfjs.getDocument({ data: pdfData, useSystemFonts: true, isEvalSupported: false }).promise;
      try {
        const page = await pdf.getPage(1);
        const textContent = await page.getTextContent();
        const pdfText = textContent.items.filter(item => "str" in item).map(item => item.str).join(" ").trim();
        if (pdfText.replace(/\s/g, "").length >= 20) {
          text = pdfText;
        } else {
          status.textContent = "A preparar a primeira página do PDF para reconhecimento local…";
          const baseViewport = page.getViewport({ scale: 1 });
          const scale = Math.min(1.5, 2200 / Math.max(baseViewport.width, baseViewport.height), Math.sqrt(4000000 / (baseViewport.width * baseViewport.height)));
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.ceil(viewport.width));
          canvas.height = Math.max(1, Math.ceil(viewport.height));
          const context = canvas.getContext("2d");
          if (!context) throw new Error("O dispositivo não suporta a leitura deste PDF.");
          await page.render({ canvas, canvasContext: context, viewport }).promise;
          worker = await getOcrWorker(status);
          const result = await worker.recognize(canvas);
          text = result.data.text.trim();
        }
      } finally {
        await pdf.destroy();
      }
    } else {
      worker = await getOcrWorker(status);
      const result = await worker.recognize(selectedPhoto);
      text = result.data.text.trim();
    }
    if (!text) {
      status.textContent = "Não foi possível reconhecer texto. Pode preencher os campos manualmente.";
      return;
    }
    const suggestions = guessDocumentDetails(text);
    if (suggestions.title && !$("#record-title").value.trim()) {
      $("#record-title").value = suggestions.title.slice(0, 100);
    }
    if (suggestions.type && !$("#record-title").dataset.userSelectedType) {
      $("#record-type").value = suggestions.type;
      updateRecordTitleLabel();
    }
    if (suggestions.date) $("#record-date").value = toDisplayDate(suggestions.date);
    const existingNotes = $("#record-notes").value.trim();
    $("#record-notes").value = [existingNotes, `Texto lido do documento:\n${text}`].filter(Boolean).join("\n\n").slice(0, 500);
    status.textContent = `Leitura concluída. ${suggestions.date ? "Data encontrada; " : ""}${suggestions.type ? `tipo sugerido: ${suggestions.type}. ` : ""}Confirme os campos antes de guardar.`;
    if (!suggestions.title) status.textContent += " Reveja o nome do registo.";
  } catch (error) {
    console.error("Falha ao reconhecer o documento:", error);
    status.textContent = `Não foi possível ler o documento: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

$("#record-type").addEventListener("change", () => {
  $("#record-title").dataset.userSelectedType = "true";
  updateRecordTitleLabel();
});

$("#record-date").addEventListener("input", event => {
  const digits = event.target.value.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) event.target.value = digits;
  else if (digits.length <= 4) event.target.value = `${digits.slice(0, 2)}/${digits.slice(2)}`;
  else event.target.value = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
  event.target.setCustomValidity("");
});

recordForm.addEventListener("submit", async event => {
  event.preventDefault();
  const form = new FormData(recordForm);
  const editId = recordForm.dataset.editId;
  const previous = healthData.records.find(record => record.id === editId);
  if (activeProfileId && editId && previous?.profileId !== activeProfileId) {
    toast("Só pode corrigir registos do seu perfil.");
    return;
  }
  const oldRecords = healthData.records;
  let storageDate;
  try {
    storageDate = toStorageDate(String(form.get("date")));
  } catch (error) {
    $("#record-date").setCustomValidity(error.message);
    $("#record-date").reportValidity();
    return;
  }
  $("#record-date").setCustomValidity("");
  const record = {
    id: editId || crypto.randomUUID(),
    title: String(form.get("title")).trim(),
    type: String(form.get("type")),
    status: String(form.get("status")),
    date: storageDate,
    time: String(form.get("time") || ""),
    profileId: activeProfileId || String(form.get("profile") || ""),
    cost: Number(form.get("cost")) || 0,
    notes: String(form.get("notes") || "").trim(),
    photo: selectedPhoto,
    attachmentType: selectedAttachmentType,
    attachmentName: selectedAttachmentName,
    notified: previous?.notified || false,
    calendarEventId: previous?.calendarEventId || ""
  };
  try {
    healthData.records = previous
      ? healthData.records.map(item => item.id === editId ? record : item)
      : [...healthData.records, record];
    await persist();
    recordDialog.close();
    currentPage = "registos";
    render();
    toast(editId ? "Registo atualizado." : "Registo guardado neste dispositivo.");
    checkReminders();
  } catch (error) {
    healthData.records = oldRecords;
    console.error("Falha ao guardar registo:", error);
    toast(`Não foi possível guardar: ${error.message}`);
  }
});

profileForm.addEventListener("submit", async event => {
  event.preventDefault();
  const form = new FormData(profileForm);
  const editId = profileForm.dataset.editId;
  const previous = healthData.profiles.find(profile => profile.id === editId);
  if (activeProfileId && editId !== activeProfileId) {
    toast("Só pode corrigir os dados do seu perfil.");
    return;
  }
  const profile = {
    ...previous,
    id: editId || crypto.randomUUID(),
    name: String(form.get("name")).trim(),
    phone: String(form.get("phone") || "").trim(),
    email: String(form.get("email") || "").trim(),
    address: String(form.get("address") || "").trim(),
    locality: String(form.get("locality") || "").trim(),
    postalCode: String(form.get("postalCode") || "").trim(),
    city: String(form.get("city") || "").trim(),
    healthNumber: String(form.get("healthNumber") || "").trim(),
    socialNumber: String(form.get("socialNumber") || "").trim()
  };
  const oldProfiles = healthData.profiles;
  healthData.profiles = previous
    ? healthData.profiles.map(item => item.id === editId ? profile : item)
    : [...healthData.profiles, profile];
  try {
    await persist();
    profileDialog.close();
    currentPage = "perfis";
    render();
    toast(previous ? "Perfil atualizado neste dispositivo." : "Perfil guardado neste dispositivo.");
  } catch (error) {
    console.error("Falha ao guardar perfil:", error);
    healthData.profiles = oldProfiles;
    toast(`Não foi possível guardar o perfil: ${error.message}`);
  }
});

profilePinForm.addEventListener("submit", async event => {
  event.preventDefault();
  const form = new FormData(profilePinForm);
  const profile = healthData.profiles.find(item => item.id === String(form.get("profile")));
  const pin = String(form.get("pin") || "");
  if (!profile || !/^\d{6}$/.test(pin)) {
    $("#profile-pin-error").textContent = "Introduza um PIN de exatamente 6 dígitos.";
    return;
  }
  if (pin !== String(form.get("confirm") || "")) {
    $("#profile-pin-error").textContent = "Os PINs não coincidem.";
    return;
  }
  const oldSalt = profile.accessPinSalt;
  const oldVerifier = profile.accessPinVerifier;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  try {
    profile.accessPinSalt = bytesToBase64(salt);
    profile.accessPinVerifier = await deriveProfilePinVerifier(pin, salt);
    await persist();
    profilePinDialog.close();
    render();
    toast(`PIN de acesso de ${profile.name} guardado.`);
  } catch (error) {
    profile.accessPinSalt = oldSalt || "";
    profile.accessPinVerifier = oldVerifier || "";
    console.error("Falha ao guardar o PIN do perfil:", error);
    $("#profile-pin-error").textContent = `Não foi possível guardar o PIN: ${error.message}`;
  }
});

profileLoginForm.addEventListener("submit", async event => {
  event.preventDefault();
  const form = new FormData(profileLoginForm);
  const profile = healthData.profiles.find(item => item.id === String(form.get("profile")));
  const pin = String(form.get("pin") || "");
  if (!profile?.accessPinSalt || !profile.accessPinVerifier || !/^\d{6}$/.test(pin)) {
    $("#profile-login-error").textContent = "Escolha um perfil e introduza o PIN de 6 dígitos.";
    return;
  }
  try {
    const verifier = await deriveProfilePinVerifier(pin, base64ToBytes(profile.accessPinSalt));
    if (verifier !== profile.accessPinVerifier) {
      $("#profile-login-pin").value = "";
      $("#profile-login-error").textContent = "PIN incorreto. Confirme os dígitos e tente novamente.";
      return;
    }
    activeProfileId = profile.id;
    profileLoginDialog.close();
    currentPage = "inicio";
    render();
    toast(`Acesso ao perfil de ${profile.name}.`);
  } catch (error) {
    console.error("Falha ao verificar o PIN do perfil:", error);
    $("#profile-login-error").textContent = `Não foi possível validar o PIN: ${error.message}`;
  }
});

function requestGoogleAccessToken(clientId) {
  if (!window.google?.accounts?.oauth2) {
    return Promise.reject(new Error("A ligação segura à Google ainda está a carregar. Confirme a ligação à internet e tente novamente."));
  }
  return new Promise((resolve, reject) => {
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: "https://www.googleapis.com/auth/calendar.events",
      callback: response => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error_description || response.error || "A autorização Google não foi concluída."));
          return;
        }
        resolve(response.access_token);
      },
      error_callback: error => reject(new Error(error.message || "Não foi possível abrir a autorização Google."))
    });
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

function localDateTimeWithOffset(date, time) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const value = new Date(year, month - 1, day, hour, minute);
  const offset = -value.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const offsetHours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const offsetMinutes = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00${sign}${offsetHours}:${offsetMinutes}`;
}

async function createCalendarEvent(record) {
  if (record.calendarEventId) {
    toast("Este evento já foi criado no Google Calendar.");
    return;
  }
  const clientId = healthData.calendarClientId?.trim();
  if (!clientId || !/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    document.querySelector("dialog[open]")?.close();
    currentPage = "definicoes";
    render();
    toast("Configure primeiro o ID de cliente OAuth nas Definições.");
    return;
  }
  const accessToken = await requestGoogleAccessToken(clientId);
  let event;
  const description = [record.type, profileName(record.profileId), record.notes].filter(Boolean).join("\n");
  if (record.time) {
    const start = new Date(`${record.date}T${record.time}:00`);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const endDate = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
    const endTime = `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
    event = {
      summary: record.title,
      description,
      start: { dateTime: localDateTimeWithOffset(record.date, record.time) },
      end: { dateTime: localDateTimeWithOffset(endDate, endTime) }
    };
  } else {
    const [year, month, day] = record.date.split("-").map(Number);
    const nextDay = new Date(year, month - 1, day + 1);
    const endDate = `${nextDay.getFullYear()}-${String(nextDay.getMonth() + 1).padStart(2, "0")}-${String(nextDay.getDate()).padStart(2, "0")}`;
    event = { summary: record.title, description, start: { date: record.date }, end: { date: endDate } };
  }
  const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(event)
  });
  const result = await response.json();
  if (!response.ok) {
    const reason = result.error?.message || `Erro HTTP ${response.status}.`;
    throw new Error(`O Google Calendar não criou o evento: ${reason}`);
  }
  record.calendarEventId = result.id;
  try {
    await persist();
  } catch (error) {
    record.calendarEventId = "";
    throw new Error(`O evento foi criado no Google Calendar, mas não foi possível guardar o identificador local. Evite repetir já a criação. ${error.message}`);
  }
  toast("Evento criado diretamente no Google Calendar.");
  return result;
}

function openRecordDetails(id) {
  const record = healthData.records.find(item => item.id === id);
  if (!record || (activeProfileId && record.profileId !== activeProfileId)) return;
  const dialog = document.createElement("dialog");
  dialog.className = "modal-dialog";
  const image = record.photo
    ? record.attachmentType === "pdf"
      ? `<iframe class="detail-pdf-preview" src="${record.photo}" title="PDF de ${escapeHtml(record.title)}"></iframe><a class="text-button" href="${record.photo}" download="${escapeHtml(record.attachmentName || "documento.pdf")}">Abrir ou descarregar ${escapeHtml(record.attachmentName || "PDF")}</a>`
      : `<img src="${record.photo}" alt="Documento de ${escapeHtml(record.title)}" style="display:block;width:100%;max-height:320px;object-fit:contain;border-radius:8px;background:#edf3f1;margin:10px 0">`
    : "";
  dialog.innerHTML = `<div class="modal-card">
    <div class="modal-heading"><div><p class="eyebrow">${escapeHtml(record.type).toLocaleUpperCase("pt-PT")}</p><h2>${escapeHtml(record.title)}</h2></div><button type="button" class="icon-button" data-action="close-details" aria-label="Fechar">×</button></div>
    <p class="row-meta">${escapeHtml(formatDate(record.date))}${record.time ? ` · ${escapeHtml(record.time)}` : ""} · ${escapeHtml(profileName(record.profileId))}</p>
    <p><span class="status ${statusClass(record.status)}">${escapeHtml(record.status)}</span> ${Number(record.cost) > 0 ? `<span class="row-cost">${money(record.cost)}</span>` : ""}</p>
    ${record.notes ? `<p class="muted">${escapeHtml(record.notes)}</p>` : ""}${image}
    <div class="modal-actions"><button type="button" class="button button-light" data-action="edit-record" data-id="${escapeHtml(record.id)}">Editar</button>
    ${record.status !== "Concluído" ? `<button type="button" class="button button-light" data-action="mark-done" data-id="${escapeHtml(record.id)}">Marcar concluído</button>` : ""}
    ${!activeProfileId ? (record.calendarEventId ? `<span class="status done">Evento criado no Google Calendar</span>` : `<button type="button" class="button button-primary" data-action="calendar-event" data-id="${escapeHtml(record.id)}">Criar diretamente no Calendar</button>`) : ""}
    ${!activeProfileId ? `<button type="button" class="button button-danger" data-action="delete-record" data-id="${escapeHtml(record.id)}">Eliminar</button>` : ""}
    </div></div>`;
  document.body.append(dialog);
  dialog.showModal();
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
}

async function handleClick(event) {
  const target = event.target.closest("button, a, [data-record]");
  if (!target) return;
  if (target.dataset.page) {
    currentPage = target.dataset.page;
    render();
    return;
  }
  if (target.dataset.filter) {
    currentFilter = target.dataset.filter;
    renderRecords();
    return;
  }
  if (target.dataset.reportPeriod) {
    renderReports(target.dataset.reportPeriod);
    return;
  }
  if (target.dataset.action === "new-record") return openRecordForm(null, target.dataset.type || "");
  if (target.dataset.action === "capture-document") return startDocumentCamera();
  if (target.dataset.action === "take-photo") return captureDocumentPhoto();
  if (target.dataset.action === "native-camera") {
    stopDocumentCamera();
    cameraInput.click();
    return;
  }
  if (target.dataset.action === "cancel-camera") {
    stopDocumentCamera();
    $("#ocr-status").textContent = "";
    return;
  }
  if (target.dataset.action === "new-profile") {
    if (activeProfileId) return toast("Só o responsável pode adicionar perfis.");
    return openProfileForm();
  }
  if (target.dataset.action === "edit-profile") {
    const profile = healthData.profiles.find(item => item.id === target.dataset.id);
    if (!profile || (activeProfileId && profile.id !== activeProfileId)) return toast("Não pode aceder a esse perfil.");
    return openProfileForm(profile);
  }
  if (target.dataset.action === "set-profile-pin") {
    if (activeProfileId) return toast("Só o responsável pode definir PINs de acesso.");
    return openProfilePinForm(target.dataset.id);
  }
  if (target.dataset.action === "profile-login") {
    if (activeProfileId) return toast("Termine primeiro o acesso ao perfil atual.");
    return openProfileLoginForm();
  }
  if (target.dataset.action === "end-profile-session") {
    if (!activeProfileId) return;
    return lockApplication();
  }
  if (target.dataset.action === "edit-record") {
    const id = target.dataset.id;
    const record = healthData.records.find(item => item.id === id);
    if (!record || (activeProfileId && record.profileId !== activeProfileId)) return toast("Não pode aceder a esse registo.");
    target.closest("dialog").close();
    return openRecordForm(record);
  }
  if (target.dataset.action === "calendar-event") {
    const record = healthData.records.find(item => item.id === target.dataset.id);
    if (!record || (activeProfileId && record.profileId !== activeProfileId)) return toast("Não pode aceder a esse registo.");
    if (activeProfileId) return toast("A criação de eventos no Calendar está disponível apenas ao responsável.");
    target.disabled = true;
    try {
      await createCalendarEvent(record);
      if (record.calendarEventId) {
        target.closest("dialog").close();
        render();
      }
    } catch (error) {
      console.error("Falha ao criar evento no Google Calendar:", error);
      toast(error.message);
    } finally {
      if (target.isConnected) target.disabled = false;
    }
    return;
  }
  if (target.dataset.action === "read-document") return readDocument();
  if (target.dataset.action === "save-google-client") {
    if (activeProfileId) return toast("Só o responsável pode alterar a configuração do Calendar.");
    const clientId = $("#google-client-id").value.trim();
    if (clientId && !/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
      $("#google-client-id").setCustomValidity("Introduza um ID OAuth terminado em .apps.googleusercontent.com.");
      $("#google-client-id").reportValidity();
      return;
    }
    $("#google-client-id").setCustomValidity("");
    const previousClientId = healthData.calendarClientId;
    healthData.calendarClientId = clientId;
    try {
      await persist();
      toast(clientId ? "ID OAuth guardado neste dispositivo." : "ID OAuth removido.");
    } catch (error) {
      healthData.calendarClientId = previousClientId;
      console.error("Falha ao guardar o ID de cliente OAuth:", error);
      toast(`Não foi possível guardar o ID: ${error.message}`);
    }
    return;
  }
  if (target.dataset.action === "close-dialog") {
    [recordDialog, profileDialog, profilePinDialog, profileLoginDialog].forEach(dialog => {
      if (dialog.open) dialog.close();
    });
    return;
  }
  if (target.dataset.action === "remove-photo") return updatePhotoPreview("");
  if (target.dataset.action === "close-details") return target.closest("dialog").close();
  if (target.dataset.action === "mark-done") {
    const record = healthData.records.find(item => item.id === target.dataset.id);
    if (activeProfileId && record?.profileId !== activeProfileId) return toast("Não pode alterar esse registo.");
    if (record) {
      const previousStatus = record.status;
      record.status = "Concluído";
      try {
        await persist();
        target.closest("dialog").close();
        render();
        toast("Registo atualizado como concluído.");
      } catch (error) {
        record.status = previousStatus;
        console.error("Falha ao atualizar o estado do registo:", error);
        toast(`Não foi possível atualizar o registo: ${error.message}`);
      }
    }
    return;
  }
  if (target.dataset.action === "delete-record") {
    if (activeProfileId) return toast("Só o responsável pode eliminar registos.");
    if (!window.confirm("Eliminar este registo e o documento associado? Esta ação não pode ser anulada.")) return;
    const oldRecords = healthData.records;
    healthData.records = oldRecords.filter(record => record.id !== target.dataset.id);
    try {
      await persist();
      target.closest("dialog").close();
      render();
      toast("Registo eliminado.");
    } catch (error) {
      healthData.records = oldRecords;
      console.error("Falha ao eliminar registo:", error);
      toast(`Não foi possível eliminar: ${error.message}`);
    }
    return;
  }
  if (target.dataset.action === "export-backup") {
    if (activeProfileId) return toast("Só o responsável pode exportar cópias.");
    return exportBackup();
  }
  if (target.dataset.action === "import-backup") {
    if (activeProfileId) return toast("Só o responsável pode importar cópias.");
    return $("#backup-file").click();
  }
  if (target.dataset.action === "toggle-reminders") {
    if (activeProfileId) return toast("Só o responsável pode gerir os lembretes.");
    return toggleReminders();
  }
  if (target.dataset.action === "lock") return lockApplication();
  const row = target.closest("[data-record]");
  if (row) openRecordDetails(row.dataset.record);
}

document.addEventListener("click", handleClick);
document.addEventListener("input", event => {
  if (event.target.matches(".search-box")) {
    searchTerm = event.target.value;
    const cursor = event.target.selectionStart;
    renderRecords();
    const replacement = $(".search-box");
    replacement.focus();
    replacement.setSelectionRange(cursor, cursor);
  }
});

document.addEventListener("change", event => {
  if (event.target.matches("#report-month")) renderReports();
  if (event.target.matches("#report-year")) renderReports();
});

async function exportBackup() {
  try {
    await persist();
    const blob = new Blob([JSON.stringify(vault)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `gestao-medica-copia-${todayISO()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    toast("Cópia cifrada exportada. Guarde-a no seu Google Drive.");
  } catch (error) {
    console.error("Falha ao exportar cópia de segurança:", error);
    toast(`Não foi possível exportar a cópia: ${error.message}`);
  }
}

document.addEventListener("change", async event => {
  if (!event.target.matches("#backup-file")) return;
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    const importedSalt = base64ToBytes(imported.salt);
    const importedKey = await deriveKey(pinInput.value || await requestImportPin(), importedSalt);
    const importedData = await decryptData(imported, importedKey);
    const confirmImport = window.confirm("Importar esta cópia substitui os registos atuais deste dispositivo. Pretende continuar?");
    if (!confirmImport) return;
    await putVault(imported);
    cryptoKey = importedKey;
    healthData = importedData;
    vault = imported;
    activeProfileId = "";
    render();
    toast("Cópia de segurança importada.");
  } catch (error) {
    console.error("Falha ao importar cópia:", error);
    toast(error.name === "OperationError" ? "Não foi possível abrir a cópia. Confirme que usou o PIN correto." : `Não foi possível importar a cópia: ${error.message}`);
  }
});

function requestImportPin() {
  const pin = window.prompt("Introduza o PIN usado para criar esta cópia cifrada:");
  if (!pin || !/^\d{6}$/.test(pin)) throw new Error("É necessário introduzir o PIN de seis dígitos.");
  return pin;
}

async function toggleReminders() {
  if (!("Notification" in window)) return toast("Este navegador não suporta notificações.");
  const oldValue = healthData.remindersEnabled;
  if (!healthData.remindersEnabled) {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return toast("As notificações não foram autorizadas neste dispositivo.");
    healthData.remindersEnabled = true;
  } else {
    healthData.remindersEnabled = false;
  }
  try {
    await persist();
    render();
    toast(healthData.remindersEnabled ? "Notificações ativadas enquanto a app está aberta." : "Notificações desativadas.");
    checkReminders();
  } catch (error) {
    healthData.remindersEnabled = oldValue;
    console.error("Falha ao guardar preferência de notificações:", error);
    toast(`Não foi possível guardar esta preferência: ${error.message}`);
  }
}

async function checkReminders() {
  if (!healthData?.remindersEnabled || !("Notification" in window) || Notification.permission !== "granted") return;
  const now = Date.now();
  const due = scopedRecords().filter(record => {
    if (!record.date || record.status === "Concluído" || record.notified) return false;
    const eventTime = new Date(`${record.date}T${record.time || "09:00"}:00`).getTime();
    return eventTime > now && eventTime - now <= 24 * 60 * 60 * 1000;
  });
  for (const record of due) {
    new Notification("Lembrete de saúde", {
      body: `${record.title} está marcado para ${formatDate(record.date)}${record.time ? ` às ${record.time}` : ""}.`,
      icon: "./app-icon.svg",
      tag: record.id
    });
    record.notified = true;
  }
  if (due.length) {
    try {
      await persist();
    } catch (error) {
      console.error("Falha ao atualizar o estado dos lembretes:", error);
      toast(`Não foi possível atualizar lembretes: ${error.message}`);
    }
  }
}

function lockApplication() {
  window.clearTimeout(lockTimer);
  healthData = null;
  cryptoKey = null;
  activeProfileId = "";
  currentPage = "inicio";
  app.classList.add("hidden");
  lockScreen.classList.remove("hidden");
  setPinMode(false);
  pinInput.focus();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    window.clearTimeout(lockTimer);
    checkReminders();
  } else if (healthData) {
    lockTimer = window.setTimeout(lockApplication, 2 * 60 * 1000);
    stopDocumentCamera();
  }
});
window.setInterval(checkReminders, 60 * 1000);

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("./sw.js").catch(error => {
    console.error("Não foi possível ativar o modo offline:", error);
  });
}

initialize();
