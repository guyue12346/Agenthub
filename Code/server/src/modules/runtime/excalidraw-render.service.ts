import { Injectable } from "@nestjs/common";
import type { UiAgentDesignCandidate } from "./ui-agent.schemas.js";

export interface ExcalidrawRenderResult {
  png: Buffer;
  svg: string;
  excalidrawJson: string;
}

@Injectable()
export class ExcalidrawRenderService {
  async render(design: UiAgentDesignCandidate): Promise<ExcalidrawRenderResult> {
    const excalidraw = buildExcalidrawDocument(design);
    const svg = buildSvg(design);
    const png = await renderPngFromSvg(svg).catch(() => fallbackPng());
    return {
      png,
      svg,
      excalidrawJson: JSON.stringify(excalidraw, null, 2)
    };
  }
}

function buildExcalidrawDocument(design: UiAgentDesignCandidate) {
  const elements: Array<Record<string, unknown>> = [];
  let y = 80;
  elements.push(rect("hero", 80, y, 1120, 170, "#dbeafe", "#3b82f6"));
  elements.push(text("title", 120, y + 46, design.title, 34));
  elements.push(text("summary", 120, y + 100, design.summary, 18));
  y += 230;
  const screens = design.screens.length > 0 ? design.screens : [{
    name: "主界面",
    purpose: "承载核心流程",
    layout: "四列工作台布局",
    sections: ["消息列表", "聊天区", "预览区", "状态面板"],
    interactions: ["点击产物打开预览", "点击 Agent 头像查看状态"]
  }];
  for (const [index, screen] of screens.slice(0, 3).entries()) {
    const x = 80 + index * 380;
    elements.push(rect(`screen-${index}`, x, y, 340, 360, "#f8fafc", "#94a3b8"));
    elements.push(text(`screen-${index}-title`, x + 24, y + 28, screen.name, 22));
    elements.push(text(`screen-${index}-purpose`, x + 24, y + 70, screen.purpose, 14));
    for (const [sectionIndex, section] of screen.sections.slice(0, 5).entries()) {
      elements.push(rect(`screen-${index}-section-${sectionIndex}`, x + 24, y + 115 + sectionIndex * 42, 292, 30, "#ffffff", "#cbd5e1"));
      elements.push(text(`screen-${index}-section-${sectionIndex}-text`, x + 42, y + 121 + sectionIndex * 42, section, 13));
    }
  }
  return {
    type: "excalidraw",
    version: 2,
    source: "agenthub-ui-agent",
    elements,
    appState: {
      viewBackgroundColor: "#ffffff",
      gridSize: null
    },
    files: {}
  };
}

function rect(id: string, x: number, y: number, width: number, height: number, backgroundColor: string, strokeColor: string) {
  return {
    id,
    type: "rectangle",
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor,
    backgroundColor,
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0.8,
    opacity: 100,
    groupIds: [],
    roundness: { type: 3 },
    seed: Math.floor((x + y + width + height) * 1000),
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false
  };
}

function text(id: string, x: number, y: number, content: string, fontSize: number) {
  return {
    id,
    type: "text",
    x,
    y,
    width: Math.max(120, Math.min(980, content.length * fontSize * 0.72)),
    height: fontSize * 1.4,
    angle: 0,
    strokeColor: "#0f172a",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: Math.floor((x + y + fontSize) * 1000),
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    text: content,
    fontSize,
    fontFamily: 1,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    originalText: content,
    lineHeight: 1.25
  };
}

function buildSvg(design: UiAgentDesignCandidate) {
  const width = 1280;
  const height = 860;
  const screens = design.screens.length > 0 ? design.screens : [{
    name: "主界面",
    purpose: "承载核心流程",
    layout: "四列工作台布局",
    sections: ["消息列表", "聊天区", "预览区", "状态面板"],
    interactions: ["点击产物打开预览", "点击 Agent 头像查看状态"]
  }];
  const cards = screens.slice(0, 3).map((screen, index) => {
    const x = 70 + index * 390;
    const sections = screen.sections.slice(0, 5).map((section, sectionIndex) => {
      const y = 366 + sectionIndex * 52;
      return [
        `<rect x="${x + 26}" y="${y}" width="318" height="36" rx="10" fill="#ffffff" stroke="#dbe3ef"/>`,
        `<text x="${x + 44}" y="${y + 24}" fill="#334155" font-size="14">${escapeXml(section)}</text>`
      ].join("");
    }).join("");
    return [
      `<rect x="${x}" y="260" width="370" height="390" rx="24" fill="#f8fafc" stroke="#cbd5e1"/>`,
      `<text x="${x + 26}" y="312" fill="#0f172a" font-size="25" font-weight="700">${escapeXml(screen.name)}</text>`,
      `<text x="${x + 26}" y="344" fill="#64748b" font-size="15">${escapeXml(screen.purpose)}</text>`,
      sections
    ].join("");
  }).join("");
  const criteria = design.acceptanceCriteria.slice(0, 4).map((item, index) => (
    `<text x="96" y="${730 + index * 30}" fill="#334155" font-size="15">• ${escapeXml(item)}</text>`
  )).join("");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    "<defs>",
    "<linearGradient id=\"hero\" x1=\"0\" x2=\"1\"><stop stop-color=\"#dbeafe\"/><stop offset=\"1\" stop-color=\"#eef2ff\"/></linearGradient>",
    "<filter id=\"shadow\" x=\"-20%\" y=\"-20%\" width=\"140%\" height=\"140%\"><feDropShadow dx=\"0\" dy=\"12\" stdDeviation=\"18\" flood-color=\"#1e293b\" flood-opacity=\"0.12\"/></filter>",
    "</defs>",
    "<rect width=\"1280\" height=\"860\" fill=\"#ffffff\"/>",
    "<rect x=\"64\" y=\"58\" width=\"1152\" height=\"164\" rx=\"30\" fill=\"url(#hero)\" filter=\"url(#shadow)\"/>",
    `<text x="96" y="124" fill="#0f172a" font-size="38" font-weight="800">${escapeXml(design.title)}</text>`,
    `<text x="98" y="172" fill="#475569" font-size="18">${escapeXml(design.summary)}</text>`,
    cards,
    "<rect x=\"70\" y=\"690\" width=\"1140\" height=\"118\" rx=\"22\" fill=\"#f8fafc\" stroke=\"#dbe3ef\"/>",
    "<text x=\"96\" y=\"718\" fill=\"#0f172a\" font-size=\"19\" font-weight=\"700\">验收重点</text>",
    criteria || "<text x=\"96\" y=\"748\" fill=\"#334155\" font-size=\"15\">• 信息层级清晰，关键操作可见。</text>",
    "</svg>"
  ].join("");
}

async function renderPngFromSvg(svg: string) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
    await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
    return await page.screenshot({ type: "png", fullPage: true });
  } finally {
    await browser.close();
  }
}

function fallbackPng() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l2z0mQAAAABJRU5ErkJggg==",
    "base64"
  );
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
