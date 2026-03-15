import { buildWecomApiUrl } from "./network-config.js";

function ensureFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomDocClient: ${name} is required`);
  }
}

function readString(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || "";
}

function normalizeDocType(docType) {
  if (docType === 3 || docType === "3") return 3;
  if (docType === 4 || docType === "4") return 4;
  if (docType === 5 || docType === "5") return 5;
  const normalized = readString(docType).toLowerCase();
  if (!normalized || normalized === "doc") return 3;
  if (normalized === "spreadsheet" || normalized === "sheet" || normalized === "table") return 4;
  if (normalized === "smart_table" || normalized === "smarttable") return 5;
  throw new Error(`Unsupported WeCom docType: ${String(docType)}`);
}

function mapDocTypeLabel(docType) {
  if (docType === 5) return "smart_table";
  if (docType === 4) return "spreadsheet";
  return "doc";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readObject(value) {
  return isRecord(value) ? value : {};
}

function readArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeDocMemberEntry(value) {
  if (typeof value === "string" || typeof value === "number") {
    const userid = readString(value);
    return userid ? { userid } : null;
  }
  if (!isRecord(value)) return null;
  const entry = { ...value };
  if (!readString(entry.userid) && readString(entry.userId)) {
    entry.userid = readString(entry.userId);
  }
  delete entry.userId;
  if (!readString(entry.userid) && !readString(entry.partyid) && !readString(entry.tagid)) {
    return null;
  }
  if (readString(entry.userid)) entry.userid = readString(entry.userid);
  if (readString(entry.partyid)) entry.partyid = readString(entry.partyid);
  if (readString(entry.tagid)) entry.tagid = readString(entry.tagid);
  return entry;
}

function normalizeDocMemberEntryList(values) {
  return readArray(values).map(normalizeDocMemberEntry).filter(Boolean);
}

function buildDocMemberAuthRequest({
  docId,
  viewers,
  collaborators,
  removeViewers,
  removeCollaborators,
} = {}) {
  const payload = {
    docid: readString(docId),
  };
  if (!payload.docid) throw new Error("docId required");

  const normalizedViewers = normalizeDocMemberEntryList(viewers);
  const normalizedCollaborators = normalizeDocMemberEntryList(collaborators);
  const normalizedRemovedViewers = normalizeDocMemberEntryList(removeViewers);
  const normalizedRemovedCollaborators = normalizeDocMemberEntryList(removeCollaborators);

  if (normalizedViewers.length > 0) payload.update_doc_member_list = normalizedViewers;
  if (normalizedCollaborators.length > 0) payload.update_co_auth_list = normalizedCollaborators;
  if (normalizedRemovedViewers.length > 0) payload.del_doc_member_list = normalizedRemovedViewers;
  if (normalizedRemovedCollaborators.length > 0) payload.del_co_auth_list = normalizedRemovedCollaborators;

  if (
    !payload.update_doc_member_list &&
    !payload.update_co_auth_list &&
    !payload.del_doc_member_list &&
    !payload.del_co_auth_list
  ) {
    throw new Error("at least one viewer/collaborator change is required");
  }

  return payload;
}

async function parseJsonResponse(res, actionLabel) {
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    if (!res.ok) {
      throw new Error(`WeCom ${actionLabel} failed: HTTP ${res.status}`);
    }
    throw new Error(`WeCom ${actionLabel} failed: invalid JSON response`);
  }
  if (!payload || typeof payload !== "object") {
    throw new Error(`WeCom ${actionLabel} failed: empty response`);
  }
  if (!res.ok) {
    throw new Error(`WeCom ${actionLabel} failed: HTTP ${res.status} ${JSON.stringify(payload)}`);
  }
  if (Array.isArray(payload)) {
    const failedItem = payload.find((item) => Number(item?.errcode ?? 0) !== 0);
    if (failedItem) {
      throw new Error(
        `WeCom ${actionLabel} failed: ${String(failedItem?.errmsg || "unknown error")} (errcode ${String(failedItem?.errcode)})`,
      );
    }
    return payload;
  }
  if (Number(payload.errcode ?? 0) !== 0) {
    throw new Error(
      `WeCom ${actionLabel} failed: ${String(payload.errmsg || "unknown error")} (errcode ${String(payload.errcode)})`,
    );
  }
  return payload;
}

export function createWecomDocClient({
  fetchWithRetry,
  getWecomAccessToken,
} = {}) {
  ensureFunction("fetchWithRetry", fetchWithRetry);
  ensureFunction("getWecomAccessToken", getWecomAccessToken);

  async function postWecomDocApi({
    path,
    actionLabel,
    account,
    body,
  }) {
    if (!account?.corpId || !account?.corpSecret) {
      throw new Error("WeCom Doc account credentials are incomplete");
    }
    const accessToken = await getWecomAccessToken({
      corpId: account.corpId,
      corpSecret: account.corpSecret,
      proxyUrl: account.outboundProxy,
      logger: account.logger,
      apiBaseUrl: account.apiBaseUrl,
    });
    const url = buildWecomApiUrl(`${path}?access_token=${encodeURIComponent(accessToken)}`, {
      apiBaseUrl: account.apiBaseUrl,
    });
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body ?? {}),
        apiBaseUrl: account.apiBaseUrl,
      },
      3,
      1000,
      {
        proxyUrl: account.outboundProxy,
        logger: account.logger,
      },
    );
    return parseJsonResponse(res, actionLabel);
  }

  async function createDoc({ account, docName, docType, spaceId, fatherId, adminUsers }) {
    const normalizedDocType = normalizeDocType(docType);
    const payload = {
      doc_type: normalizedDocType,
      doc_name: readString(docName),
    };
    if (!payload.doc_name) throw new Error("docName required");
    const normalizedSpaceId = readString(spaceId);
    const normalizedFatherId = readString(fatherId);
    if (normalizedSpaceId) payload.spaceid = normalizedSpaceId;
    if (normalizedFatherId) payload.fatherid = normalizedFatherId;
    const normalizedAdminUsers = Array.isArray(adminUsers)
      ? adminUsers.map((item) => readString(item)).filter(Boolean)
      : [];
    if (normalizedAdminUsers.length > 0) {
      payload.admin_users = normalizedAdminUsers;
    }
    const json = await postWecomDocApi({
      path: "/cgi-bin/wedoc/create_doc",
      actionLabel: "create_doc",
      account,
      body: payload,
    });
    return {
      raw: json,
      docId: readString(json.docid),
      url: readString(json.url),
      docType: normalizedDocType,
      docTypeLabel: mapDocTypeLabel(normalizedDocType),
    };
  }

  async function renameDoc({ account, docId, newName }) {
    const payload = {
      docid: readString(docId),
      new_name: readString(newName),
    };
    if (!payload.docid) throw new Error("docId required");
    if (!payload.new_name) throw new Error("newName required");
    const json = await postWecomDocApi({
      path: "/cgi-bin/wedoc/rename_doc",
      actionLabel: "rename_doc",
      account,
      body: payload,
    });
    return {
      raw: json,
      docId: payload.docid,
      newName: payload.new_name,
    };
  }

  async function getDocBaseInfo({ account, docId }) {
    const normalizedDocId = readString(docId);
    if (!normalizedDocId) throw new Error("docId required");
    const json = await postWecomDocApi({
      path: "/cgi-bin/wedoc/get_doc_base_info",
      actionLabel: "get_doc_base_info",
      account,
      body: { docid: normalizedDocId },
    });
    return {
      raw: json,
      info: json.doc_base_info && typeof json.doc_base_info === "object" ? json.doc_base_info : {},
    };
  }

  async function shareDoc({ account, docId }) {
    const normalizedDocId = readString(docId);
    if (!normalizedDocId) throw new Error("docId required");
    const json = await postWecomDocApi({
      path: "/cgi-bin/wedoc/doc_share",
      actionLabel: "doc_share",
      account,
      body: { docid: normalizedDocId },
    });
    return {
      raw: json,
      shareUrl: readString(json.share_url),
    };
  }

  async function getDocAuth({ account, docId }) {
    const normalizedDocId = readString(docId);
    if (!normalizedDocId) throw new Error("docId required");
    const json = await postWecomDocApi({
      path: "/cgi-bin/wedoc/doc_get_auth",
      actionLabel: "doc_get_auth",
      account,
      body: { docid: normalizedDocId },
    });
    return {
      raw: json,
      accessRule: json.access_rule && typeof json.access_rule === "object" ? json.access_rule : {},
      secureSetting: json.secure_setting && typeof json.secure_setting === "object" ? json.secure_setting : {},
      docMembers: Array.isArray(json.doc_member_list) ? json.doc_member_list : [],
      coAuthList: Array.isArray(json.co_auth_list) ? json.co_auth_list : [],
    };
  }

  async function deleteDoc({ account, docId, formId }) {
    const payload = {};
    const normalizedDocId = readString(docId);
    const normalizedFormId = readString(formId);
    if (normalizedDocId) payload.docid = normalizedDocId;
    if (normalizedFormId) payload.formid = normalizedFormId;
    if (!payload.docid && !payload.formid) {
      throw new Error("docId or formId required");
    }
    const json = await postWecomDocApi({
      path: "/cgi-bin/wedoc/del_doc",
      actionLabel: "del_doc",
      account,
      body: payload,
    });
    return {
      raw: json,
      docId: payload.docid || "",
      formId: payload.formid || "",
    };
  }

  async function setDocJoinRule({ account, docId, request }) {
    const payload = {
      ...readObject(request),
    };
    payload.docid = readString(docId || payload.docid);
    if (!payload.docid) throw new Error("docId required");
    const json = await postWecomDocApi({
      path: "/cgi-bin/wedoc/mod_doc_join_rule",
      actionLabel: "mod_doc_join_rule",
      account,
      body: payload,
    });
    return {
      raw: json,
      docId: payload.docid,
    };
  }

  async function setDocMemberAuth({ account, docId, request }) {
    const payload = {
      ...readObject(request),
    };
    payload.docid = readString(docId || payload.docid);
    if (!payload.docid) throw new Error("docId required");
    const json = await postWecomDocApi({
      path: "/cgi-bin/wedoc/mod_doc_member",
      actionLabel: "mod_doc_member",
      account,
      body: payload,
    });
    return {
      raw: json,
      docId: payload.docid,
    };
  }

  async function grantDocAccess({
    account,
    docId,
    viewers,
    collaborators,
    removeViewers,
    removeCollaborators,
  }) {
    const payload = buildDocMemberAuthRequest({
      docId,
      viewers,
      collaborators,
      removeViewers,
      removeCollaborators,
    });
    const result = await setDocMemberAuth({
      account,
      docId: payload.docid,
      request: payload,
    });
    return {
      ...result,
      addedViewerCount: payload.update_doc_member_list?.length ?? 0,
      addedCollaboratorCount: payload.update_co_auth_list?.length ?? 0,
      removedViewerCount: payload.del_doc_member_list?.length ?? 0,
      removedCollaboratorCount: payload.del_co_auth_list?.length ?? 0,
    };
  }

  async function addDocCollaborators({ account, docId, collaborators }) {
    return grantDocAccess({
      account,
      docId,
      collaborators,
    });
  }

  async function setDocSafetySetting({ account, docId, request }) {
    const payload = {
      ...readObject(request),
    };
    payload.docid = readString(docId || payload.docid);
    if (!payload.docid) throw new Error("docId required");
    const json = await postWecomDocApi({
      path: "/cgi-bin/wedoc/mod_doc_safty_setting",
      actionLabel: "mod_doc_safty_setting",
      account,
      body: payload,
    });
    return {
      raw: json,
      docId: payload.docid,
    };
  }

  async function createCollect({ account, formInfo, spaceId, fatherId }) {
    const payload = {
      form_info: readObject(formInfo),
    };
    if (Object.keys(payload.form_info).length === 0) {
      throw new Error("formInfo required");
    }
    const normalizedSpaceId = readString(spaceId);
    const normalizedFatherId = readString(fatherId);
    if (normalizedSpaceId) payload.spaceid = normalizedSpaceId;
    if (normalizedFatherId) payload.fatherid = normalizedFatherId;
    const json = await postWecomDocApi({
      path: "/cgi-bin/wedoc/create_collect",
      actionLabel: "create_collect",
      account,
      body: payload,
    });
    return {
      raw: json,
      formId: readString(json.formid),
      title: readString(payload.form_info.form_title),
    };
  }

  async function modifyCollect({ account, oper, formId, formInfo }) {
    const payload = {
      oper: readString(oper),
      formid: readString(formId),
      form_info: readObject(formInfo),
    };
    if (!payload.oper) throw new Error("oper required");
    if (!payload.formid) throw new Error("formId required");
    if (Object.keys(payload.form_info).length === 0) {
      throw new Error("formInfo required");
    }
    const json = await postWecomDocApi({
      path: "/cgi-bin/wedoc/modify_collect",
      actionLabel: "modify_collect",
      account,
      body: payload,
    });
    return {
      raw: json,
      formId: payload.formid,
      oper: payload.oper,
      title: readString(payload.form_info.form_title),
    };
  }

  async function getFormInfo({ account, formId }) {
    const normalizedFormId = readString(formId);
    if (!normalizedFormId) throw new Error("formId required");
    const json = await postWecomDocApi({
      path: "/cgi-bin/wedoc/get_form_info",
      actionLabel: "get_form_info",
      account,
      body: { formid: normalizedFormId },
    });
    return {
      raw: json,
      formInfo: readObject(json.form_info),
    };
  }

  async function getFormAnswer({ account, repeatedId, answerIds }) {
    const normalizedRepeatedId = readString(repeatedId);
    if (!normalizedRepeatedId) throw new Error("repeatedId required");
    const normalizedAnswerIds = Array.isArray(answerIds)
      ? answerIds
          .map((item) => Number(item))
          .filter((item) => Number.isFinite(item))
      : [];
    const payload = {
      repeated_id: normalizedRepeatedId,
    };
    if (normalizedAnswerIds.length > 0) {
      payload.answer_ids = normalizedAnswerIds;
    }
    const json = await postWecomDocApi({
      path: "/cgi-bin/wedoc/get_form_answer",
      actionLabel: "get_form_answer",
      account,
      body: payload,
    });
    const answer = readObject(json.answer);
    return {
      raw: json,
      answer,
      answerList: readArray(answer.answer_list),
    };
  }

  async function getFormStatistic({ account, requests }) {
    const payload = Array.isArray(requests)
      ? requests.map((item) => readObject(item)).filter((item) => Object.keys(item).length > 0)
      : [];
    if (payload.length === 0) {
      throw new Error("requests required");
    }
    const json = await postWecomDocApi({
      path: "/cgi-bin/wedoc/get_form_statistic",
      actionLabel: "get_form_statistic",
      account,
      body: payload,
    });
    return {
      raw: json,
      items: readArray(json),
      successCount: readArray(json).filter((item) => Number(item?.errcode ?? 0) === 0).length,
    };
  }

  async function getSheetProperties({ account, docId }) {
    const normalizedDocId = readString(docId);
    if (!normalizedDocId) throw new Error("docId required");
    const json = await postWecomDocApi({
      path: "/cgi-bin/wedoc/spreadsheet/get_sheet_properties",
      actionLabel: "get_sheet_properties",
      account,
      body: { docid: normalizedDocId },
    });
    return {
      raw: json,
      properties:
        (Array.isArray(json.properties) && json.properties) ||
        (Array.isArray(json.sheet_properties) && json.sheet_properties) ||
        (Array.isArray(json.sheet_list) && json.sheet_list) ||
        [],
    };
  }

  return {
    createDoc,
    renameDoc,
    getDocBaseInfo,
    shareDoc,
    getDocAuth,
    deleteDoc,
    setDocJoinRule,
    setDocMemberAuth,
    grantDocAccess,
    addDocCollaborators,
    setDocSafetySetting,
    createCollect,
    modifyCollect,
    getFormInfo,
    getFormAnswer,
    getFormStatistic,
    getSheetProperties,
  };
}
