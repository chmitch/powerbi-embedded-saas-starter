import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "docs");
const escape = text => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const icons = Object.fromEntries(["browser", "entra", "app", "identity", "vault", "capacity", "sql"]
  .map(name => [name, readFileSync(path.join(directory, "icons", `${name}.svg`), "utf8")]));

const views = [
  {
    id: "overview", name: "1 - Solution overview", file: "architecture.svg", width: 1600, height: 1060,
    title: "Power BI Embedded SaaS Starter", titleSize: 26,
    subtitle: "A secure portal for tenant analytics.",
    description: "Conceptual overview with the signed-in user above the highlighted application, identity and credentials to the left, tenant analytics to the right, and supporting identities and application data below.",
    centeredCards: true,
    groups: [
      ["identity", 30, 190, 330, 690, "IDENTITY", "#f0fdfa"],
      ["application", 405, 190, 440, 690, "APP SERVICE", "#fffdf5"],
      ["fabric", 915, 190, 655, 690, "MICROSOFT FABRIC + POWER BI", "#f8fafc"],
    ],
    nodes: [
      ["user", 485, 25, 280, 125, "browser",
        ["Signed-in user", "Reports + authoring", "Role-scoped administration"], { compact: true, theme: "user" }],
      ["entra", 65, 255, 260, 180, "entra",
        ["Microsoft Entra ID", "Workforce authentication", "Authorization code + PKCE"]],
      ["app", 485, 430, 280, 190, "app",
        ["Tenant portal", "React UI + Express backend", "Tenant permissions + embed tokens", "One Linux App Service B1"], { theme: "app" }],
      ["tenants", 955, 430, 260, 190, "capacity",
        ["Tenant workspaces", "Reports + semantic models", "One workspace / principal per tenant", "Only approved content is exposed"], { theme: "analytics" }],
      ["powerbi", 1280, 430, 250, 190, "capacity",
        ["Power BI embedding", "Backend requests embed tokens", "Browser renders the report iframe"], { theme: "analytics" }],
      ["vault", 65, 675, 260, 175, "vault",
        ["Azure Key Vault", "App + tenant credentials", "Managed identity and RBAC", "Enforced network perimeter"]],
      ["identities", 485, 675, 280, 175, "identity",
        ["Managed identities", "Runtime: SQL + credential reads", "Provisioner: Graph, ARM, secrets", "Separate grants; same host"]],
      ["sql", 955, 675, 260, 175, "sql",
        ["Application data", "SQL Database in Fabric", "Dedicated management workspace", "Tenants, ACLs, sessions"]],
      ["compute", 1280, 675, 250, 175, "capacity",
        ["Compute placement", "Management: dedicated F2", "Reports: customer capacities", "Shared compute is supported"]],
    ],
    edges: [
      ["signin", "user", "entra", [[485, 85], [390, 85], [390, 170], [195, 170], [195, 255]], "Entra sign-in", 220, 157],
      ["session", "user", "app", [[625, 150], [625, 430]], "HTTPS session", 642, 335, false, true],
      ["iframe", "user", "powerbi", [[765, 85], [1405, 85], [1405, 430]],
        "Report iframe / embed token", 1000, 70, false, true],
      ["inventory", "app", "tenants", [[765, 525], [955, 525]], "Tenant-scoped API", 790, 509, false, true],
      ["content", "tenants", "powerbi", [[1215, 525], [1280, 525]], "Content", 1220, 509],
      ["data", "app", "sql", [[765, 580], [880, 580], [880, 760], [955, 760]], "App state", 790, 650, false, true],
      ["secrets", "app", "vault", [[485, 575], [195, 575], [195, 675]], "Credentials", 280, 559],
      ["identityAccess", "app", "identities", [[625, 620], [625, 675]], "", 0, 0],
    ],
    notes: [
      [40, 936, "Conceptual overview | Double arrows show requests and responses, not which service initiates every call.", 17],
      [40, 970, "One tenant per user. One workspace and embedding principal per tenant. Shared compute never merges permissions.", 17],
      [40, 1004, "Service groups are conceptual, not Azure resource-group boundaries. See the deployment view for physical placement.", 17],
    ],
  },
  {
    id: "deployment", name: "2 - Deployment", file: "architecture-deployment.svg", height: 1120,
    title: "What gets deployed",
    subtitle: "One Azure resource group. Fabric and Entra service objects live outside ARM resource-group scope.",
    description: "Single-region Azure resource layout with App Service, two identities, enforced NSP Key Vault, and separate management and customer capacities assigned to Fabric workspaces.",
    groups: [
      ["rg", 30, 120, 1220, 560, "Azure resource group - West US 3 by default", "#eff6ff"],
      ["nsp", 840, 180, 380, 205, "Enforced Network Security Perimeter", "#fff8e6"],
      ["fabric", 30, 760, 1220, 240, "Microsoft Fabric", "#eef9f4"],
    ],
    nodes: [
      ["app", 60, 220, 350, 135, "app",
        ["Linux B1 plan + web app", "One instance: React + Express", "In-process setup / reconciliation", "HTTPS; no staging slots"]],
      ["identities", 450, 220, 350, 135, "identity",
        ["Two managed identities", "Runtime: SQL DML + secret reads", "Provisioner: Graph, ARM, secrets", "Same host, separate grants"]],
      ["vault", 860, 240, 340, 120, "vault",
        ["Key Vault", "SecuredByPerimeter + RBAC", "Only app outbound IP rules"]],
      ["management", 60, 480, 500, 140, "capacity",
        ["Management Fabric F2", "Application persistence and sign-in", "Never assigned to a customer tenant", "Created by application deployment"]],
      ["customer", 660, 480, 560, 140, "capacity",
        ["Customer-report Fabric capacities", "Multiple tenant workspaces may share compute", "Created or selected explicitly during onboarding", "Not purchased by initial application deployment"]],
      ["sql", 60, 820, 500, 140, "sql",
        ["Management workspace", "SQL Database in Fabric (transactional TDS)", "Tenant/user permissions, navigation, sessions", "No tenant embedding principal access"]],
      ["tenants", 660, 820, 560, 140, "capacity",
        ["Tenant A / Tenant B / ... workspaces", "Exclusive workspace mapping per application tenant", "Reports + semantic models; one principal per tenant", "New content stays unpublished until reviewed"]],
    ],
    edges: [
      ["identity", "app", "identities", [[410, 285], [450, 285]], "", 0, 0],
      ["vaultaccess", "identities", "vault", [[800, 285], [860, 285]], "", 0, 0],
      ["managementAssignment", "management", "sql", [[310, 620], [310, 820]], "Assigned compute", 330, 724, true],
      ["customerAssignment", "customer", "tenants", [[940, 620], [940, 820]], "Assigned compute", 960, 724, true],
    ],
    notes: [
      [60, 425, "No VNet, private endpoint, separate worker, distributed cache, or deployed queue.", 18],
      [50, 1040, "Entra objects: sign-in app, tenant embedding principals, and optional embedding group. Not ARM resources.", 17],
      [50, 1070, "Dashed arrows = compute assignment, NOT network access or authorization. B1 / active Fabric compute are billable.", 17],
      [50, 1100, "Initial release is single-instance. HA, durable workers, production rotation and unattended CI/CD remain future work.", 17],
    ],
  },
];

const cell = (id, value, style, x, y, w, h, parent = "1") =>
  `<mxCell id="${id}" value="${escape(value).replaceAll("\n", "&#xa;")}" style="${escape(style)}" vertex="1" parent="${parent}"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`;
const text = (x, y, value, size = 17, bold = false, centered = false) =>
  `<text x="${x}" y="${y}" font-size="${size}"${bold ? ' font-weight="600"' : ""}${centered ? ' text-anchor="middle"' : ""}>${escape(value)}</text>`;
const labelStyle = (size, bold = false) =>
  `text;align=left;verticalAlign=middle;whiteSpace=wrap;fontSize=${size};fontStyle=${bold ? 1 : 0};`;

let drawio = '<mxfile host="app.diagrams.net">';
for (const view of views) {
  const width = view.width ?? 1280;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${view.height}" viewBox="0 0 ${width} ${view.height}" role="img" aria-labelledby="title description"><title id="title">${escape(view.title)}</title><desc id="description">${escape(view.description)}</desc><defs><marker id="arrow" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto-start-reverse"><path d="M0 0 L10 4 L0 8 Z" fill="#46617a"/></marker></defs><rect width="${width}" height="${view.height}" fill="#fff"/><g font-family="Segoe UI,Arial,sans-serif" fill="#172f47">`;
  let xml = `<diagram name="${view.name}" id="${view.id}"><mxGraphModel grid="1" gridSize="10" page="1" pageWidth="${width}" pageHeight="${view.height}"><root><mxCell id="0"/><mxCell id="1" parent="0"/>`;
  const addText = (id, x, y, value, size, bold = false, width = 1180, background = false) => {
    if (background) svg += `<rect x="${x - 4}" y="${y - size - 2}" width="${value.length * size * 0.56 + 8}" height="${size + 7}" rx="3" fill="#ffffff"/>`;
    svg += text(x, y, value, size, bold);
    xml += cell(id, value, `${labelStyle(size, bold)}${background ? "fillColor=#ffffff;strokeColor=none;" : ""}`, x, y - size, width, size + 8);
  };
  addText("title", 40, view.centeredCards ? 57 : 48, view.title, view.titleSize ?? 30, true, view.centeredCards ? 440 : 1180);
  addText("subtitle", 40, view.centeredCards ? 113 : 82, view.subtitle, 18, false, view.centeredCards ? 440 : 1180);

  for (const [id, x, y, w, h, label, fill] of view.groups) {
    svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${view.centeredCards ? 28 : 14}" fill="${fill}" stroke="#b8c7d7"/>`;
    xml += cell(id, "", `rounded=1;arcSize=8;fillColor=${fill};strokeColor=#b8c7d7;`, x, y, w, h);
    addText(`${id}Label`, x + 20, y + 32, label, view.centeredCards ? 16 : 19, true, w - 40);
  }
  for (const [id, from, to, points, label, lx, ly, dashed, bidirectional] of view.edges) {
    svg += `<polyline points="${points.map(point => point.join(",")).join(" ")}" fill="none" stroke="#46617a" stroke-width="2" stroke-linejoin="round"${dashed ? ' stroke-dasharray="7 5"' : ""}${bidirectional ? ' marker-start="url(#arrow)"' : ""} marker-end="url(#arrow)"/>`;
    const first = points[0], last = points.at(-1);
    const source = view.nodes.find(node => node[0] === from);
    const target = view.nodes.find(node => node[0] === to);
    const attachment = `exitX=${(first[0] - source[1]) / source[3]};exitY=${(first[1] - source[2]) / source[4]};entryX=${(last[0] - target[1]) / target[3]};entryY=${(last[1] - target[2]) / target[4]};exitPerimeter=0;entryPerimeter=0;`;
    xml += `<mxCell id="${id}" source="${from}" target="${to}" value="" style="${attachment}rounded=1;endArrow=block;endFill=1;${bidirectional ? "startArrow=block;startFill=1;" : ""}strokeColor=#46617a;${dashed ? "dashed=1;" : ""}" edge="1" parent="1"><mxGeometry relative="1" as="geometry"><Array as="points">${points.slice(1, -1).map(([x, y]) => `<mxPoint x="${x}" y="${y}"/>`).join("")}</Array></mxGeometry></mxCell>`;
    if (label) addText(`${id}Label`, lx, ly, label, view.centeredCards ? 15 : 16, false,
      Math.min(view.centeredCards ? label.length * 9 + 8 : 1180, width - lx), view.centeredCards);
  }
  for (const [id, x, y, w, h, icon, lines, options = {}] of view.nodes) {
    if (view.centeredCards) {
      const themes = {
        app: ["#fef3c7", "#d97706", "#78350f"],
        analytics: ["#eff6ff", "#60a5fa", "#172f47"],
        user: ["#fffbeb", "#d6a461", "#78350f"],
        default: ["#ffffff", "#94a3b8", "#172f47"],
      };
      const [fill, stroke, color] = themes[options.theme ?? "default"];
      const compact = options.compact;
      const iconX = compact ? 20 : (w - 48) / 2;
      const iconY = compact ? 34 : 20;
      svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="22" fill="${fill}" stroke="${stroke}" stroke-width="${options.theme === "app" ? 2 : 1.5}"/><image x="${x + iconX}" y="${y + iconY}" width="48" height="48" href="data:image/svg+xml;base64,${Buffer.from(icons[icon]).toString("base64")}"/>`;
      xml += cell(id, "", `rounded=1;arcSize=14;fillColor=${fill};strokeColor=${stroke};strokeWidth=${options.theme === "app" ? 2 : 1.5};`, x, y, w, h);
      xml += cell(`${id}Icon`, "", `shape=image;imageAspect=1;aspect=fixed;image=data:image/svg+xml,${encodeURIComponent(icons[icon])};`, iconX, iconY, 48, 48, id);
      for (const [i, line] of lines.entries()) {
        const tx = compact ? 85 : w / 2;
        const ty = compact ? 40 + i * 25 : 96 + (i ? 7 + i * 21 : 0);
        const size = i ? 14 : 19;
        svg += `<g fill="${color}">${text(x + tx, y + ty, line, size, !i, !compact)}</g>`;
        xml += cell(`${id}Text${i}`, line,
          `${labelStyle(size, !i)}align=${compact ? "left" : "center"};fontColor=${color};`,
          compact ? 85 : 10, ty - size, compact ? w - 95 : w - 20, size + 8, id);
      }
      continue;
    }
    svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="white" stroke="#6b8dab"/><image x="${x + 16}" y="${y + 22}" width="36" height="36" href="data:image/svg+xml;base64,${Buffer.from(icons[icon]).toString("base64")}"/>`;
    xml += cell(id, "", "rounded=1;fillColor=#ffffff;strokeColor=#6b8dab;", x, y, w, h);
    xml += cell(`${id}Icon`, "", `shape=image;imageAspect=1;aspect=fixed;image=data:image/svg+xml,${encodeURIComponent(icons[icon])};`, 16, 22, 36, 36, id);
    for (const [i, line] of lines.entries()) {
      svg += text(x + 65, y + 31 + i * 26, line, i ? 16 : 18, !i);
      xml += cell(`${id}Text${i}`, line, labelStyle(i ? 16 : 18, !i), 65, 11 + i * 26, w - 75, 26, id);
    }
  }
  for (const [i, [x, y, label, size, bold]] of view.notes.entries()) {
    addText(`note${i}`, x, y, label, size, bold);
  }
  svg += "</g></svg>\n";
  xml += "</root></mxGraphModel></diagram>";
  writeFileSync(path.join(directory, view.file), svg);
  drawio += xml;
}
writeFileSync(path.join(directory, "architecture.drawio"), `${drawio}</mxfile>\n`);
console.log("Generated overview/deployment SVGs and the two-page docs\\architecture.drawio from one source.");
