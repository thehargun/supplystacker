/*
    const projectId = "project_public_9617a013c9e778b1a0a2d841fa33874f_fQNYe28b9349477b449269181e4dfec0d13f9";
    const secretKey = "secret_key_8d8e95ed03f734463d6bd81062639ad4_W6kUPbaa8779b11d5e009f072a9475bfe8e25";
*/const fs = require("fs");
const path = require("path");

function loadDotEnv(){
  const envPath = path.join(process.cwd(), ".env");
  if(!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for(const line of lines){
    const trimmed = line.trim();
    if(!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if(eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if(key && !(key in process.env)) process.env[key] = val;
  }
}

function formatBytes(bytes){
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = bytes;
  while(v >= 1024 && i < units.length - 1){
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

async function readTextSafe(res){
  try{
    return await res.text();
  }catch{
    return "";
  }
}

async function expectOk(res){
  if(res.ok) return res;
  const text = await readTextSafe(res);
  let details = text;
  try{ details = JSON.stringify(JSON.parse(text), null, 2); }catch{}
  throw new Error(`HTTP ${res.status} ${res.statusText}\n${details}`);
}

async function main(){
  loadDotEnv();

  const inputPath = path.join(process.cwd(), "upload.pdf");
  const outputPath = path.join(process.cwd(), "download.pdf");

  if(!fs.existsSync(inputPath)){
    console.error("Missing upload.pdf in this folder.");
    process.exit(1);
  }

  const publicKey = process.env.ILOVE_PUBLIC_KEY || process.env.ILOVE_PROJECT_ID || process.env.ILOVE_PUBLIC;
  if(!publicKey){
    console.error("Missing public key. Put this in .env:\nILOVE_PUBLIC_KEY=project_public_...");
    process.exit(1);
  }

  const before = fs.statSync(inputPath).size;

  // 0) Auth: get a signed token from iLovePDF auth server
  // Endpoint and response format are in their API reference. :contentReference[oaicite:1]{index=1}
  const authRes = await expectOk(await fetch("https://api.ilovepdf.com/v1/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ public_key: publicKey })
  }));
  const authJson = await authRes.json();
  const token = authJson.token;

  if(!token){
    throw new Error(`Auth response missing token:\n${JSON.stringify(authJson, null, 2)}`);
  }

  const authHeader = { Authorization: `Bearer ${token}` };

  // 1) Start: /v1/start/{tool}/{region} :contentReference[oaicite:2]{index=2}
  const startRes = await expectOk(await fetch("https://api.ilovepdf.com/v1/start/compress/us", {
    method: "GET",
    headers: authHeader
  }));
  const startJson = await startRes.json();
  const server = startJson.server;
  const task = startJson.task;

  if(!server || !task){
    throw new Error(`Start response missing server/task:\n${JSON.stringify(startJson, null, 2)}`);
  }

  // 2) Upload: https://{server}/v1/upload :contentReference[oaicite:3]{index=3}
  const fileBuf = fs.readFileSync(inputPath);

  const form = new FormData();
  form.append("task", task);
  form.append("file", new Blob([fileBuf], { type: "application/pdf" }), "upload.pdf");

  const uploadRes = await expectOk(await fetch(`https://${server}/v1/upload`, {
    method: "POST",
    headers: authHeader,
    body: form
  }));
  const uploadJson = await uploadRes.json();
  const serverFilename = uploadJson.server_filename;

  if(!serverFilename){
    throw new Error(`Upload response missing server_filename:\n${JSON.stringify(uploadJson, null, 2)}`);
  }

  // 3) Process: https://{server}/v1/process with compression_level :contentReference[oaicite:4]{index=4}
  const processBody = {
    task,
    tool: "compress",
    compression_level: "recommended",
    files: [{ server_filename: serverFilename, filename: "upload.pdf" }]
  };

  await expectOk(await fetch(`https://${server}/v1/process`, {
    method: "POST",
    headers: { ...authHeader, "Content-Type": "application/json" },
    body: JSON.stringify(processBody)
  }));

  // 4) Download: https://{server}/v1/download/{task} :contentReference[oaicite:5]{index=5}
  const downloadRes = await expectOk(await fetch(`https://${server}/v1/download/${task}`, {
    method: "GET",
    headers: authHeader
  }));

  const outBuf = Buffer.from(await downloadRes.arrayBuffer());
  fs.writeFileSync(outputPath, outBuf);

  const after = fs.statSync(outputPath).size;
  const reduction = before > 0 ? (1 - after / before) * 100 : 0;

  console.log("Saved download.pdf");
  console.log("Input :", formatBytes(before));
  console.log("Output:", formatBytes(after));
  console.log("Reduced:", `${reduction.toFixed(2)}%`);
}

main().catch((err) => {
  console.error("Compression failed:");
  console.error(err?.message || err);
  process.exit(1);
});
