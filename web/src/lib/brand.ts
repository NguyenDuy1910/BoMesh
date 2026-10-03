export type AppBrandKey = "bomesh";

export const appBrandKey: AppBrandKey = "bomesh";
export const PRODUCT_NAME = "BoMesh";
export const PLATFORM_NAME = "BoMesh";

export const appBrand = {
  key: appBrandKey,
  shortName: PRODUCT_NAME,
  productName: PRODUCT_NAME,
  platformName: PLATFORM_NAME,
  controlPlaneName: "Control Plane",
  controlPlaneSubtitle: "Control plane",
  /** BoMesh: Business-only Knowledge Mesh. */
  workspaceSubtitle: "Business-only Knowledge Mesh",
  logo: {
    src: "/bomesh-logo.png",
    alt: `${PRODUCT_NAME} logo`,
    imageClassName: "object-contain",
  },
} as const;
