import type { TriState } from "../src/types";
import {
  TEXT_FIELDS,
  validateFallbackText,
  validateOptionalText,
  validateRequiredText,
} from "../src/lib/textPolicy";
import { isExternalFacilityIdFormat } from "./externalFacilityRegistry";

const CATEGORIES = [
  "department",
  "station",
  "convenience",
  "park",
  "hotel",
  "cafe",
] as const;

const TOILET_ID_RE = /^toilet-user-[A-Za-z0-9-]{1,64}$/;

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

function isInt1to5(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 5;
}

export function isExternalFacilityId(id: string): boolean {
  return isExternalFacilityIdFormat(id);
}

export interface ToiletInput {
  id: string;
  name: string;
  category: (typeof CATEGORIES)[number];
  address: string;
  floorInfo?: string;
  cleanlinessScore?: number;
  description: string;
  lat: number;
  lng: number;
  attributes: {
    hasWashlet: TriState;
    hasMultipurpose: TriState;
    hasBabyTable: TriState;
    hasPowderRoom: TriState;
    isOpen24h: TriState;
  };
}

export function validateToiletInput(body: unknown): ValidationResult<ToiletInput> {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { ok: false, error: "invalid body" };
  const value = body as Record<string, any>;
  if (typeof value.id !== "string" || !TOILET_ID_RE.test(value.id))
    return { ok: false, error: "invalid id" };
  if (!CATEGORIES.includes(value.category))
    return { ok: false, error: "invalid category" };
  if (typeof value.lat !== "number" || value.lat < -90 || value.lat > 90)
    return { ok: false, error: "invalid lat" };
  if (typeof value.lng !== "number" || value.lng < -180 || value.lng > 180)
    return { ok: false, error: "invalid lng" };
  if (
    value.cleanlinessScore !== undefined &&
    (typeof value.cleanlinessScore !== "number" ||
      value.cleanlinessScore < 1 ||
      value.cleanlinessScore > 5)
  ) {
    return { ok: false, error: "invalid cleanlinessScore" };
  }

  const nameField = validateRequiredText(value.name, TEXT_FIELDS.toiletName);
  if (nameField.ok === false) return nameField;
  const addressField = validateFallbackText(value.address, TEXT_FIELDS.toiletAddress);
  if (addressField.ok === false) return addressField;
  const floorInfoField = validateOptionalText(
    value.floorInfo,
    TEXT_FIELDS.toiletFloorInfo
  );
  if (floorInfoField.ok === false) return floorInfoField;
  const descriptionField = validateFallbackText(
    value.description,
    TEXT_FIELDS.toiletDescription
  );
  if (descriptionField.ok === false) return descriptionField;

  const a = value.attributes;
  if (a !== undefined && (a === null || typeof a !== "object" || Array.isArray(a)))
    return { ok: false, error: "invalid attributes" };
  for (const key of [
    "hasWashlet",
    "hasMultipurpose",
    "hasBabyTable",
    "hasPowderRoom",
    "isOpen24h",
  ] as const) {
    if (
      a !== undefined &&
      a[key] !== undefined &&
      a[key] !== null &&
      typeof a[key] !== "boolean"
    ) {
      return { ok: false, error: `invalid attributes.${key}` };
    }
  }

  return {
    ok: true,
    value: {
      id: value.id,
      name: nameField.value,
      category: value.category,
      address: addressField.value,
      floorInfo: floorInfoField.value,
      description: descriptionField.value,
      lat: value.lat,
      lng: value.lng,
      attributes: {
        hasWashlet: a?.hasWashlet ?? null,
        hasMultipurpose: a?.hasMultipurpose ?? null,
        hasBabyTable: a?.hasBabyTable ?? null,
        hasPowderRoom: a?.hasPowderRoom ?? null,
        isOpen24h: a?.isOpen24h ?? null,
      },
    },
  };
}

export interface ReviewInput {
  userName: string;
  overallScore: number;
  cleanlinessScore: number;
  odorScore: number;
  suppliesScore: number;
  comment: string;
}

export function validateReviewInput(body: unknown): ValidationResult<ReviewInput> {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { ok: false, error: "invalid body" };
  const root = body as Record<string, any>;
  const review = root.review ?? root;
  if (!review || typeof review !== "object" || Array.isArray(review))
    return { ok: false, error: "invalid body" };
  if (review.rating !== undefined && !isInt1to5(review.rating))
    return { ok: false, error: "invalid rating" };
  if (review.overallScore !== undefined && !isInt1to5(review.overallScore))
    return { ok: false, error: "invalid overallScore" };
  const overall = review.overallScore ?? review.rating;
  if (!isInt1to5(overall))
    return {
      ok: false,
      error: review.rating === undefined ? "invalid overallScore" : "invalid rating",
    };
  if (!isInt1to5(review.cleanlinessScore))
    return { ok: false, error: "invalid cleanlinessScore" };
  if (!isInt1to5(review.odorScore))
    return { ok: false, error: "invalid odorScore" };
  if (!isInt1to5(review.suppliesScore))
    return { ok: false, error: "invalid suppliesScore" };

  const commentField = validateRequiredText(review.comment, TEXT_FIELDS.comment);
  if (commentField.ok === false) return commentField;
  const userNameField = validateFallbackText(review.userName, TEXT_FIELDS.userName);
  if (userNameField.ok === false) return userNameField;

  return {
    ok: true,
    value: {
      userName: userNameField.value,
      overallScore: overall,
      cleanlinessScore: review.cleanlinessScore,
      odorScore: review.odorScore,
      suppliesScore: review.suppliesScore,
      comment: commentField.value,
    },
  };
}

export function validateReportInput(
  body: unknown
): ValidationResult<{ reason: string }> {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { ok: false, error: "invalid body" };
  const reasonField = validateRequiredText(
    (body as Record<string, unknown>).reason,
    TEXT_FIELDS.reason
  );
  if (reasonField.ok === false) return reasonField;
  return { ok: true, value: { reason: reasonField.value } };
}
