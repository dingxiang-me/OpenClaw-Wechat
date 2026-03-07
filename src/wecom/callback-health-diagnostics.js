function previewBody(body, maxLength = 120) {
  return String(body ?? "").slice(0, Math.max(1, maxLength));
}

function isHtmlBody(body) {
  return /<!doctype html|<html/i.test(String(body ?? ""));
}

export function diagnoseWecomCallbackHealth({
  status,
  body,
  mode = "agent",
  endpoint = "",
  webhookPath = "",
  gatewayPort = null,
  location = "",
} = {}) {
  const rawBody = String(body ?? "");
  const preview = previewBody(rawBody);
  const normalizedMode = String(mode ?? "agent").trim().toLowerCase() === "bot" ? "bot" : "agent";
  const healthyMarker = normalizedMode === "bot" ? "wecom bot webhook" : "wecom webhook";
  const healthy = status === 200 && rawBody.toLowerCase().includes(healthyMarker);
  if (healthy) {
    return {
      ok: true,
      detail: `status=${status} body=${preview}`,
      data: null,
    };
  }

  const hints = [];
  let reason = "unexpected-response";
  const effectivePath = String(webhookPath ?? "").trim() || String(endpoint ?? "").trim() || "/";
  const authScopeHint =
    normalizedMode === "bot"
      ? "为 /wecom/*（以及 legacy /webhooks/wecom*）单独放行，或使用独立回调域名/端口"
      : "为 /wecom/*（以及 legacy /webhooks/app*）单独放行，或使用独立回调域名/端口";

  if (status === 404) {
    reason = "route-not-found";
    hints.push(`路径 ${effectivePath} 未命中${normalizedMode === "bot" ? " Bot" : ""}回调路由`);
  } else if (status === 401 || status === 403) {
    reason = "gateway-auth";
    hints.push("回调路径被 Gateway Auth / Zero Trust / 反向代理鉴权拦截");
    hints.push("企业微信回调与健康探测必须直达 webhook 路径，不能要求 Authorization、Cookie 或交互登录");
    hints.push(authScopeHint);
  } else if ([301, 302, 303, 307, 308].includes(Number(status))) {
    reason = "redirect-auth";
    hints.push("回调路径发生了重定向，通常被登录页、SSO 或前端路由接管");
    if (location) hints.push(`重定向目标：${location}`);
    hints.push("请让 webhook 路径直接反代到 OpenClaw 网关，不要跳转到登录页或前端应用");
  } else if (status === 502 || status === 503 || status === 504) {
    reason = "gateway-unreachable";
    if (gatewayPort != null) {
      hints.push(`网关 ${gatewayPort} 端口不可达或反向代理后端异常`);
    } else {
      hints.push("网关端口不可达或反向代理后端异常");
    }
  } else if (status === 200 && isHtmlBody(rawBody)) {
    reason = "html-fallback";
    hints.push("返回了 WebUI HTML，通常表示 webhook 路由未注册或 webhookPath 配置不一致");
    if (webhookPath) {
      const configPathHint =
        normalizedMode === "bot"
          ? `请确认 channels.wecom.bot.webhookPath=${webhookPath} 与企业微信后台回调地址完全一致`
          : `请确认 channels.wecom.webhookPath=${webhookPath} 与企业微信后台回调地址完全一致`;
      hints.push(configPathHint);
    }
    hints.push("确认插件已加载：plugins.entries.openclaw-wechat.enabled=true 且 plugins.allow 包含 openclaw-wechat");
  }

  return {
    ok: false,
    detail: `status=${status} body=${preview}${hints.length > 0 ? ` hint=${hints.join("；")}` : ""}`,
    data: {
      status,
      reason,
      mode: normalizedMode,
      endpoint: endpoint || null,
      webhookPath: webhookPath || null,
      gatewayPort: gatewayPort == null ? null : gatewayPort,
      location: location || null,
      hints,
    },
  };
}
