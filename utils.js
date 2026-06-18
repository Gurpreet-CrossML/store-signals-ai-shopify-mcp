const axios = require("axios");
const dotenv = require("dotenv");
const https = require("https");
const {
  storeMetadataQuery,
  relatedProductsQuery,
} = require("./graphql_queries");
const { getCache, setCache } = require("./cache");

// Load environment variables from .env file
dotenv.config();

const SHOPIFY_BASE_URL = process.env.SHOPIFY_BASE_URL;
const SHOPIFY_STOREFRONT_API_TOKEN = process.env.SHOPIFY_STOREFRONT_API_TOKEN;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const MCP_NAME = process.env.MCP_NAME;
const MCP_VERSION = process.env.MCP_VERSION;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const BACKEND_API_URL = process.env.BACKEND_API_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL;

const allEnvironmentVariables = {
  MCP_NAME,
  MCP_VERSION,
  SHOPIFY_BASE_URL,
  SHOPIFY_STOREFRONT_API_TOKEN,
  SHOPIFY_ACCESS_TOKEN,
  SMTP_USER,
  SMTP_PASS,
  BACKEND_API_URL,
  OPENAI_API_KEY,
  OPENAI_MODEL,
};

// Validate environment variables
for (const [key, value] of Object.entries(allEnvironmentVariables)) {
  if (!value) {
    console.error(`ERROR: ${key} environment variable is required`);
    process.exit(1);
  }
}

// Define sort options and their mapping to Shopify's sort keys and reverse flags
const SortOption = Object.freeze({
  RELEVANCE: "relevance",
  PRICE_ASC: "price_asc",
  PRICE_DESC: "price_desc",
  NEWEST: "newest",
  BEST_SELLING: "best_selling",
});

// Mapping of user-friendly sort options to Shopify's sort keys and reverse flags
const SHOPIFY_SORT_MAPPING = {
  [SortOption.RELEVANCE]: {
    sortKey: "RELEVANCE",
    reverse: false,
  },

  [SortOption.PRICE_ASC]: {
    sortKey: "PRICE",
    reverse: false,
  },

  [SortOption.PRICE_DESC]: {
    sortKey: "PRICE",
    reverse: true,
  },

  [SortOption.NEWEST]: {
    sortKey: "CREATED_AT",
    reverse: true,
  },

  [SortOption.BEST_SELLING]: {
    sortKey: "BEST_SELLING",
    reverse: false,
  },
};

// Utility function to call Shopify API
const callShopifyApi = async (
  method = "GET",
  endpoint = "",
  data = null,
  isAdmin = false,
) => {
  try {
    let url = isAdmin
      ? `${SHOPIFY_BASE_URL}/admin/api/2025-10/graphql.json`
      : `${SHOPIFY_BASE_URL}/api/2025-01/graphql.json`;
    if (endpoint) {
      url = `${SHOPIFY_BASE_URL}${endpoint}`;
    }

    console.log(`Calling Shopify API: ${method} - ${url}`);

    const headers = {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_API_TOKEN,
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
    };

    const config = {
      method,
      url,
      headers,
      timeout: 15000, // 15 seconds timeout
      data: data ? JSON.stringify(data) : undefined,
      // Bypass SSL certificate verification for development
      httpsAgent: new https.Agent({
        rejectUnauthorized: false,
      }),
    };

    const response = await axios(config);
    return response.data;
  } catch (error) {
    console.error(
      "Shopify API Error:",
      error?.response?.data || error.message || error?.errors,
    );
    throw error;
  }
};

// Utility function to call the backend API
const callBackendAPI = async (method, endpoint, data = {}) => {
  try {
    const url = `${BACKEND_API_URL}${endpoint}`;

    console.log(`Calling Backend API: ${method} - ${url}`);

    const config = {
      method,
      url,
      timeout: 15000,
      data: data,
    };

    const response = await axios(config);
    return response?.data?.data;
  } catch (err) {
    console.error("Error calling backend API, error:", err?.response?.data);
    return null;
  }
};

// Utility function to get currency symbol from currency code
const getCurrencySymbol = (code) => {
  const symbols = {
    USD: "$",
    INR: "₹",
  };
  return symbols[code] || (code ? `${code} ` : "");
};

// Convert a numeric value from various units to centimeters.
function toCm(value, unit) {
  if (value == null) return NaN;
  const num = Number(value);
  if (Number.isNaN(num)) return NaN;
  const u = (unit || "").toString().toLowerCase();
  switch (u) {
    case "cm":
      return num;
    case "mm":
      return num / 10;
    case "m":
      return num * 100;
    case "in":
    case "inch":
    case "inches":
      return num * 2.54;
    case "ft":
    case "feet":
      return num * 30.48;
    default:
      return num; // assume already cm if unknown
  }
}

// Save viewed products to backend for analytics
const logProductViewEvents = async (products, session_id, store_code) => {
  if (!Array.isArray(products) || !session_id || !store_code) {
    return;
  }

  await Promise.all(
    products.map((product) => {
      const productId = String(product?.id || "")
        .split("/")
        .pop();
      if (!productId) return Promise.resolve();

      return callBackendAPI("POST", "/chat/bot-events/", {
        thread_id: session_id,
        event_type: "view_product",
        store_code,
        product_id: productId,
        product_name: product?.name || "",
        category: product?.category || "",
      });
    }),
  ).catch((err) => {
    console.warn("logProductViewEvents failed:", err?.message || err);
  });
};

// Utility function to calculate discount details for a product variant
const getVariantDiscount = (variant) => {
  const price = parseFloat(variant.priceV2?.amount || 0);
  const compare = parseFloat(variant.compareAtPriceV2?.amount || 0);

  if (compare && compare > price) {
    const discount = ((compare - price) / compare) * 100;

    return {
      original_price: compare,
      discounted_price: price,
      discount_percentage: Math.round(discount),
      savings: compare - price,
    };
  }

  return null;
};

// Utility function to format products data received from Shopify API, and also log product view events to the backend for analytics.
const formatProducts = (
  products,
  session_id,
  store_code,
  full_details = false,
) => {
  try {
    return products.map(({ node }) => {
      const productId = node.id.split("/").pop();
      const productName = node.title;
      const productCategory = node?.category?.name;

      // Log product view event to backend for analytics
      callBackendAPI("POST", "/chat/bot-events/", {
        thread_id: session_id,
        event_type: "view_product",
        store_code: store_code,
        product_id: productId,
        product_name: productName,
        category: productCategory || "",
      });

      const baseProduct = {
        id: productId,
        name: productName,
        category: productCategory,
        price: `${getCurrencySymbol(node.priceRange?.minVariantPrice?.currencyCode)}${node.priceRange?.minVariantPrice?.amount || 0}`,
        description: node.description || "",
        available_for_sale: node.availableForSale,
      };

      if (!full_details) {
        return baseProduct;
      }

      return {
        ...baseProduct,
        image: node.images?.edges?.[0]?.node?.url || null,
        product_url:
          node.onlineStoreUrl || `${SHOPIFY_BASE_URL}/products/${node?.handle}`,
        variants: node.variants?.edges?.map(({ node: v }) => {
          const discount = getVariantDiscount(v);

          return {
            variant_id: v.id.split("/").pop(),
            variant_name: v.title,

            variant_price: `${getCurrencySymbol(v.priceV2?.currencyCode)}${v.priceV2?.amount || 0}`,

            compare_at_price: v.compareAtPriceV2?.amount
              ? `${getCurrencySymbol(v.compareAtPriceV2?.currencyCode)}${v.compareAtPriceV2.amount}`
              : null,

            discount: discount,

            available_for_sale: v.availableForSale,
            options: v.selectedOptions,
          };
        }),
      };
    });
  } catch (err) {
    console.error("Error formatting products, error:", err);
    return [];
  }
};

// Utility function to fetch store metadata like product tags, types, collections, and categories. This metadata can be used for various purposes like improving search relevance, generating search queries, etc.
const storeMetadata = async () => {
  const cacheKey = "store_metadata";

  try {
    const cachedMetadata = await getCache(cacheKey);
    if (cachedMetadata) {
      return cachedMetadata;
    }

    const graphqlQuery = {
      query: storeMetadataQuery,
    };

    const result = await callShopifyApi("POST", "", graphqlQuery);

    if (result.errors) {
      return {
        tags: [],
        types: [],
        collections: [],
        categories: [],
      };
    }

    const tags =
      result?.data?.productTags?.edges?.map((item) => item?.node) || [];

    const types =
      result?.data?.productTypes?.edges?.map((item) => item?.node) || [];

    const collections =
      result?.data?.collections?.edges?.map((item) => item?.node?.title) || [];

    const categories = [
      ...new Set(
        (
          result?.data?.products?.edges?.map(
            (item) => item?.node?.category?.name,
          ) || []
        ).filter(Boolean),
      ),
    ];

    const metadata = {
      tags,
      types,
      collections,
      categories,
    };

    try {
      await setCache(cacheKey, metadata);
    } catch (cacheError) {
      console.warn(
        "storeMetadata cache set failed:",
        cacheError?.message || cacheError,
      );
    }
    return metadata;
  } catch (error) {
    console.error("productsMetadata Error:", error);

    return {
      tags: [],
      types: [],
      collections: [],
      categories: [],
    };
  }
};

// Utility function to extract relevant search terms from a user query using OpenAI's language model. It uses the store metadata to generate more accurate and relevant search terms that can be used to query the product catalog.
const extractSearchTerms = async (query) => {
  if (!query || typeof query !== "string") {
    return [];
  }

  try {
    const metadata = await storeMetadata();

    const prompt = `You are an eCommerce search query generator.

    Given a user query and store catalog metadata, generate 3-4 short search queries to find relevant products.

    Rules:
    - Each query should contain a maximum of 2 words and can also be a single-word query.
    - Queries must look like real ecommerce catalog searches
    - Use catalog metadata to pick accurate product type terms
    - Never use conversational language
    - Return ONLY a JSON array of strings, nothing else

    Store Catalog Metadata:
    - Product Types: ${metadata.types.filter(Boolean).join(", ") || "N/A"}
    - Collections: ${metadata.collections.filter(Boolean).join(", ") || "N/A"}
    - Categories: ${metadata.categories.filter(Boolean).join(", ") || "N/A"}
    - Tags: ${metadata.tags.filter(Boolean).slice(0, 50).join(", ") || "N/A"}

    User Query: "${query}"

    Return format: ["query1", "query2", "query3"]`;

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: OPENAI_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 100,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        timeout: 10000,
      },
    );

    const content = response?.data?.choices?.[0]?.message?.content?.trim();
    const cleaned = content.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((q) => typeof q === "string" && q.trim().length > 0)
      .map((q) => q.trim().toLowerCase())
      .slice(0, 4);
  } catch (error) {
    console.error("extractSearchTerms Error:", error);
    return [];
  }
};

// Utility function to fetch related products for a given product ID using Shopify's product recommendations API. This can be used to provide additional product suggestions to users based on the products they are viewing or have shown interest in.
const fetchRelatedProducts = async (product_id) => {
  try {
    if (!product_id) return [];

    const graphqlQuery = {
      query: relatedProductsQuery,
      variables: {
        productId: `gid://shopify/Product/${product_id}`,
      },
    };

    // Call Shopify API
    const searchResponse = await callShopifyApi("POST", "", graphqlQuery);

    const recommendations = searchResponse?.data?.productRecommendations || [];

    if (!recommendations.length) {
      return [];
    }

    // Extract clean product IDs
    const productIds = recommendations.map((product) =>
      product.id.replace("gid://shopify/Product/", ""),
    );

    return productIds.slice(0, 4);
  } catch (error) {
    console.log("Related product search getting error, Error:", error);
    return [];
  }
};

// Utility function to get Shopify sort arguments based on a given sort key. It maps user-friendly sort keys to the corresponding Shopify sort options that can be used in GraphQL queries to fetch sorted product results.
const getProductSortConfig = (sortKey) => {
  const normalizedKey = String(sortKey || "").toLowerCase();

  return (
    SHOPIFY_SORT_MAPPING[normalizedKey] ||
    SHOPIFY_SORT_MAPPING[SortOption.RELEVANCE]
  );
};

// Utility function to parse space input and convert dimensions to centimeters. This can be used to filter products based on available space by extracting dimensions from product descriptions and converting them to a standard unit for comparison.
const parseSpaceInput = (space) => {
  if (!space || typeof space !== "object") {
    console.warn("Invalid space object:", space);
    return null;
  }

  const width =
    typeof space.width === "number" ? space.width : parseFloat(space.width);
  const length =
    typeof space.length === "number" ? space.length : parseFloat(space.length);
  const unit = space.unit?.toLowerCase();

  if (isNaN(width) || isNaN(length) || !unit) {
    console.warn("Invalid dimensions in space:", space);
    return null;
  }

  const widthCm = toCm(width, unit);
  const lengthCm = toCm(length, unit);

  return {
    widthCm,
    lengthCm,
    isValid: true,
    original: { width, length, unit },
  };
};

// Utility function to convert dimensions to centimeters
const extractDimensions = (description) => {
  if (!description) return null;

  const text = description.replace(/\n/g, " ").toLowerCase();

  const extractValue = (label) => {
    const regex = new RegExp(`${label}[^0-9]*([\\d.]+)\\s*(cm|m)`, "i");
    const match = text.match(regex);

    if (!match) return null;

    let value = parseFloat(match[1]);
    const unit = match[2];

    if (unit === "m") value = value * 100;

    return value;
  };

  const length = extractValue("length");
  const width = extractValue("width");
  const height = extractValue("height");

  return { length, width, height };
};

// Utility function to normalize dimensions by ensuring both length and width are present, and if one is missing, using the other value. This can help in cases where only one dimension is provided but can be assumed to be square.
const normalizeDims = (dims) => {
  if (!dims) return null;

  let { length, width } = dims;

  if (!length && width) length = width;
  if (!width && length) width = length;

  if (!length && !width) return null;

  return { length, width };
};

// Utility function to calculate a relevance score for a product based on its title and dimensions. This can be used to rank products based on how well they fit within the available space, with certain keywords and smaller dimensions contributing to a higher score.
const getRelevanceScore = (product, dims) => {
  let score = 0;

  const title = (product.title || "").toLowerCase();

  // Good for small spaces
  if (
    title.includes("table") ||
    title.includes("side") ||
    title.includes("stool")
  )
    score += 3;
  if (title.includes("wall") || title.includes("shelf")) score += 4;

  // Bad for small spaces
  if (
    title.includes("sofa") ||
    title.includes("bed") ||
    title.includes("wardrobe")
  )
    score -= 5;
  if (title.includes("sideboard")) score -= 3;

  // Dimension-based scoring
  if (dims) {
    const area = dims.length * dims.width;
    if (area < 5000) score += 3;
    else if (area < 10000) score += 1;
    else score -= 2;
  }

  return score;
};

// Utility function to determine the applicability of a discount based on its type and associated items.
const getAppliesTo = (discount) => {
  const items = discount?.customerGets?.items;

  if (!items) return { type: "all" };

  switch (items.__typename) {
    case "AllDiscountItems":
      return { type: "all" };

    case "DiscountProducts":
      return {
        type: "products",
        products:
          items.products?.edges?.map((e) => ({
            title: e.node.title,
          })) || [],
      };

    case "DiscountCollections":
      return {
        type: "collections",
        collections:
          items.collections?.edges?.map((e) => ({
            title: e.node.title,
          })) || [],
      };

    default:
      return { type: "unknown" };
  }
};

// Utility function to calculate the discount value and type (percentage or fixed amount) based on the discount's customerGets value. This can be used to display the discount information to users in a clear and concise manner, indicating how much they can save with the discount.
const getDiscountValue = (discount) => {
  const value = discount?.customerGets?.value;

  if (!value) return null;

  switch (value.__typename) {
    case "DiscountPercentage": {
      const percentage = value.percentage * 100;
      return {
        type: "percentage",
        value: percentage,
        label: `${percentage}% OFF`,
      };
    }

    case "DiscountAmount":
      return {
        type: "fixed",
        value: parseFloat(value.amount?.amount || 0),
        currency: value.amount?.currencyCode,
        label: `₹${value.amount?.amount} OFF`,
      };

    default:
      return null;
  }
};

// Utility function to format discounts from Shopify's discount data, including determining the type of discount, its applicability, and generating a user-friendly description. This can be used to display discount information to users in a clear and concise manner.
const formatDiscounts = (discounts) => {
  if (!discounts || !Array.isArray(discounts)) return [];

  const now = Date.now();

  const validDiscounts = discounts.filter((d) => {
    const discount = d?.node?.discount;
    if (!discount) return false;

    const startsAt = discount.startsAt
      ? new Date(discount.startsAt).getTime()
      : null;
    const endsAt = discount.endsAt ? new Date(discount.endsAt).getTime() : null;

    if (startsAt && startsAt > now) return false;
    if (endsAt && endsAt < now) return false;

    return true;
  });

  return validDiscounts.map((d) => {
    const discount = d.node.discount;
    const type = discount.__typename;

    const code = discount.codes?.edges?.[0]?.node?.code || null;

    const appliesTo = getAppliesTo(discount);

    let normalizedType = "unknown";
    let description;

    switch (type) {
      case "DiscountCodeBasic":
        normalizedType = "code";
        description = code
          ? `Use code ${code} to get a discount`
          : `Apply discount code to get offer`;
        break;

      case "DiscountAutomaticBasic":
        normalizedType = "automatic";
        description = "Discount will be applied automatically at checkout";
        break;

      case "DiscountAutomaticBxgy":
        normalizedType = "bxgy";
        description = discount.title || "Buy X get Y offer";
        break;

      case "DiscountAutomaticFreeShipping":
        normalizedType = "free_shipping";
        description = discount.title || "Free shipping offer";
        break;

      default:
        description = discount.title || "Discount available";
    }

    // Improve description based on applicability
    if (appliesTo.type === "collections" && appliesTo.collections.length) {
      description += ` (Valid on ${appliesTo.collections.map((c) => c.title).join(", ")})`;
    }

    if (appliesTo.type === "products" && appliesTo.products.length) {
      description += ` (Valid on selected products)`;
    }

    const discountValue = getDiscountValue(discount);

    return {
      type: normalizedType,
      title: discount.title,
      code,
      description,
      isAutomatic: type !== "DiscountCodeBasic",
      appliesTo,
      discountValue,
    };
  });
};

// Utility function to determine cancellation eligibility based on order status and timestamps. It checks if the order is already cancelled, if it has been fulfilled or shipped, and if it has been refunded or voided to determine if a cancellation is allowed and provides an appropriate reason if not.
const getCancelStatus = (o) => {
  if (o.cancelled_at)
    return { allowed: false, reason: "Order already cancelled" };

  if (["fulfilled", "shipped"].includes(o.fulfillment_status)) {
    return { allowed: false, reason: "Order already shipped" };
  }

  if (["refunded", "voided"].includes(o.financial_status)) {
    return { allowed: false, reason: "Order already refunded" };
  }

  return { allowed: true };
};

// Utility function to determine return eligibility based on order status and timestamps. It checks if the order is cancelled, if it has been delivered, and if it falls within the return window (e.g., 7 days from delivery) to determine if a return is allowed and provides an appropriate reason if not.
const getReturnStatus = (o) => {
  if (o.cancelled_at) {
    return { allowed: false, reason: "Order is cancelled" };
  }

  if (!["fulfilled", "delivered"].includes(o.fulfillment_status)) {
    return { allowed: false, reason: "Order not delivered yet" };
  }

  const createdDate = new Date(o.created_at);
  const now = new Date();

  const diffDays = (now - createdDate) / (1000 * 60 * 60 * 24);

  if (diffDays > 7) {
    return { allowed: false, reason: "Return window expired (7 days)" };
  }

  return { allowed: true };
};

// Utility function to format order details received from Shopify API, including calculating cancel and return eligibility based on order status and timestamps. This can be used to provide customers with clear information about their orders and their options for cancellation or returns.
const formatOrder = (o) => {
  const cancelStatus = getCancelStatus(o);
  const returnStatus = getReturnStatus(o);

  // Extract shipment status from active fulfillments only
  const fulfillments = o.fulfillments || [];
  const activeFulfillments = fulfillments.filter(
    (f) => (f.status || "").toLowerCase() !== "cancelled",
  );
  const isDelivered = activeFulfillments.some(
    (f) => (f.shipment_status || "").toLowerCase() === "delivered",
  );

  const shipmentStatus = isDelivered
    ? "delivered"
    : (o.fulfillment_status || "").toLowerCase() === "fulfilled"
      ? "shipped"
      : "not_shipped";

  const formattedOrder = {
    order_id: o.order_number,
    shopify_order_id: o.id,
    email: o.email,
    financial_status: o.financial_status,
    fulfillment_status: o.fulfillment_status,
    shipment_status: shipmentStatus,
    created_at: o.created_at,
    cancelled_at: o.cancelled_at,
    cancel_reason: o.cancel_reason,
    payment_gateways: o.payment_gateway_names,
    note: o.note,
    discount_codes: o?.discount_codes,
    order_url: o?.order_status_url,

    subtotal: `${getCurrencySymbol(o.presentment_currency)}${o.subtotal_price || 0}`,
    discount: `${getCurrencySymbol(o.presentment_currency)}${o.total_discounts}`,
    total: `${getCurrencySymbol(o.presentment_currency)}${o.total_price || 0}`,
    tax: `${getCurrencySymbol(o.presentment_currency)}${o.total_tax || 0}`,

    is_cancelable: cancelStatus.allowed,
    cancel_message: cancelStatus.reason || "Eligible for cancel",
    is_returnable: returnStatus.allowed,
    return_message: returnStatus.reason || "Eligible for return",

    items: o.line_items.map((item) => ({
      line_item_id: item.id,
      product_id: item.product_id,
      variant_id: item.variant_id,
      name: item.name,
      quantity: item.quantity,
      price: `${getCurrencySymbol(o.presentment_currency)}${item.price || 0}`,
    })),
  };

  return formattedOrder;
};

/**
 * ShopifyOrderEditor — implements the 3-step Order Edit API:
 *   Step 1: orderEditBegin      → obtain a calculatedOrder ID
 *   Step 2: apply mutations     → addVariant | setQuantity | removeLineItem
 *   Step 3: orderEditCommit     → persist changes and optionally notify customer
 *
 * Derives the shop domain from SHOPIFY_BASE_URL (e.g. https://xxx.myshopify.com)
 * and the access token from SHOPIFY_ACCESS_TOKEN — both already defined in .env.
 */
class ShopifyOrderEditor {
  constructor() {
    // Parse hostname from SHOPIFY_BASE_URL (e.g. "https://blushora-pdczux7n.myshopify.com")
    const baseUrl = SHOPIFY_BASE_URL || "";
    this.shopDomain = baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
    this.accessToken = SHOPIFY_ACCESS_TOKEN;
    this.apiVersion = process.env.SHOPIFY_API_VERSION || "2024-04";
    this.graphqlEndpoint = `https://${this.shopDomain}/admin/api/${this.apiVersion}/graphql.json`;
  }

  async _graphql(query, variables = {}) {
    const response = await axios.post(
      this.graphqlEndpoint,
      { query, variables },
      {
        headers: {
          "X-Shopify-Access-Token": this.accessToken,
          "Content-Type": "application/json",
        },
      },
    );
    const { data, errors } = response.data;
    if (errors?.length > 0) {
      throw new Error(`GraphQL Errors: ${JSON.stringify(errors)}`);
    }
    return data;
  }

  // Step 1 – Begin
  async beginOrderEdit(orderId) {
    const data = await this._graphql(
      `mutation BeginOrderEdit($orderId: ID!) {
        orderEditBegin(id: $orderId) {
          calculatedOrder { id }
          userErrors { field message }
        }
      }`,
      { orderId },
    );
    return data.orderEditBegin;
  }

  // Step 2a – Add a variant
  async addVariant(calculatedOrderId, variantId, quantity, locationId = null) {
    const data = await this._graphql(
      `mutation AddVariant($id: ID!, $variantId: ID!, $quantity: Int!, $locationId: ID) {
        orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity, locationId: $locationId) {
          calculatedOrder { id }
          userErrors { field message }
        }
      }`,
      { id: calculatedOrderId, variantId, quantity, locationId },
    );
    return data.orderEditAddVariant;
  }

  // Step 2b – Update quantity of an existing line item
  async setQuantity(calculatedOrderId, lineItemId, quantity) {
    const data = await this._graphql(
      `mutation SetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!) {
        orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity) {
          calculatedOrder { id }
          userErrors { field message }
        }
      }`,
      { id: calculatedOrderId, lineItemId, quantity },
    );
    return data.orderEditSetQuantity;
  }

  // Step 2c – Remove a line item
  async removeLineItem(calculatedOrderId, lineItemId) {
    return await this.setQuantity(calculatedOrderId, lineItemId, 0);
  }

  // Step 3 – Commit
  async commitOrderEdit(
    calculatedOrderId,
    notifyCustomer = false,
    staffNote = "Modified via MCP Server",
  ) {
    const data = await this._graphql(
      `mutation CommitOrderEdit($id: ID!, $notifyCustomer: Boolean, $staffNote: String) {
        orderEditCommit(id: $id, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
          order { id name totalPriceSet { shopMoney { amount currencyCode } } }
          userErrors { field message }
        }
      }`,
      { id: calculatedOrderId, notifyCustomer, staffNote },
    );
    return data.orderEditCommit;
  }

  /**
   * High-level orchestrator used by the MCP tool.
   * @param {string}   orderId   Full GID, e.g. "gid://shopify/Order/123"
   * @param {Array}    changes   Array of change descriptors (see tool schema)
   * @param {object}   options   { notifyCustomer, staffNote }
   */
  async modifyOrder(orderId, changes = [], options = {}) {
    // Step 1
    const begin = await this.beginOrderEdit(orderId);
    if (begin.userErrors?.length) {
      throw new Error(`Begin edit failed: ${begin.userErrors[0].message}`);
    }
    const calcId = begin.calculatedOrder.id;

    // Step 2 – apply each change in sequence
    for (const change of changes) {
      let result;
      if (change.type === "addVariant") {
        result = await this.addVariant(
          calcId,
          change.variantId,
          change.quantity,
          change.locationId ?? null,
        );
      } else if (change.type === "setQuantity") {
        result = await this.setQuantity(
          calcId,
          change.lineItemId,
          change.quantity,
        );
      } else if (change.type === "remove") {
        result = await this.removeLineItem(calcId, change.lineItemId);
      } else {
        throw new Error(`Unknown change type: "${change.type}"`);
      }

      if (result?.userErrors?.length) {
        throw new Error(
          `Change "${change.type}" failed: ${result.userErrors[0].message}`,
        );
      }
    }

    // Step 3
    const commit = await this.commitOrderEdit(
      calcId,
      options.notifyCustomer ?? false,
      options.staffNote ?? "Modified via MCP Server",
    );

    if (commit.userErrors?.length) {
      throw new Error(`Commit failed: ${commit.userErrors[0].message}`);
    }

    return {
      success: true,
      orderId: commit.order.id,
      orderName: commit.order.name,
      totalPrice: commit.order.totalPriceSet?.shopMoney,
      message: "Order modified successfully.",
    };
  }
}

/**
 * ShopifyExchangeManager – implements the Exchange API:
 *   Step 1: fetch returnable fulfillments
 *   Step 2: returnCreate (with exchange line items)
 *   Step 3: returnProcess
 */
class ShopifyExchangeManager {
  constructor() {
    const baseUrl = SHOPIFY_BASE_URL || "";
    this.shopDomain = baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
    this.accessToken = SHOPIFY_ACCESS_TOKEN;
    this.apiVersion = process.env.SHOPIFY_API_VERSION || "2024-04";
    this.graphqlEndpoint = `https://${this.shopDomain}/admin/api/${this.apiVersion}/graphql.json`;
  }

  // Low-level GraphQL caller
  async _graphql(query, variables = {}) {
    const response = await axios.post(
      this.graphqlEndpoint,
      { query, variables },
      {
        headers: {
          "X-Shopify-Access-Token": this.accessToken,
          "Content-Type": "application/json",
        },
      }
    );
    const { data, errors } = response.data;
    if (errors?.length > 0) {
      throw new Error(`GraphQL Errors: ${JSON.stringify(errors)}`);
    }
    return data;
  }

  // Step 1 – get returnable fulfillments for an order
  async getReturnableFulfillments(orderId) {
    const query = `
      query GetReturnableFulfillments($orderId: ID!) {
        returnableFulfillments(orderId: $orderId, first: 10) {
          edges {
            node {
              id
              fulfillment { id }
              returnableFulfillmentLineItems(first: 10) {
                edges {
                  node {
                    fulfillmentLineItem { id }
                    quantity
                  }
                }
              }
            }
          }
        }
      }
    `;
    const data = await this._graphql(query, { orderId });
    return data.returnableFulfillments.edges;
  }

  // Step 2 – create return with exchange items
  async createReturnWithExchange(
    returnableFulfillmentId,
    returnLineItems,   // [{ fulfillmentLineItemId, quantity }]
    exchangeLineItems  // [{ variantId, quantity }]
  ) {
    const mutation = `
      mutation CreateReturnWithExchange($input: ReturnInput!) {
        returnCreate(returnInput: $input) {
          return { id, status }
          userErrors { field message }
        }
      }
    `;
    const variables = {
      input: {
        returnableFulfillmentId,
        returnLineItems: returnLineItems.map(item => ({
          fulfillmentLineItemId: item.fulfillmentLineItemId,
          quantity: item.quantity,
        })),
        exchangeLineItems: exchangeLineItems.map(item => ({
          variantId: item.variantId,
          quantity: item.quantity,
        })),
      },
    };
    const data = await this._graphql(mutation, variables);
    const result = data.returnCreate;
    if (result.userErrors?.length) {
      throw new Error(`Return creation failed: ${result.userErrors[0].message}`);
    }
    return result.return;
  }

  // Step 3 – process the return to finalise exchange
  async processReturn(returnId) {
    const mutation = `
      mutation ProcessReturn($returnId: ID!) {
        returnProcess(returnId: $returnId) {
          return { id, status }
          userErrors { field message }
        }
      }
    `;
    const data = await this._graphql(mutation, { returnId });
    const result = data.returnProcess;
    if (result.userErrors?.length) {
      throw new Error(`Return processing failed: ${result.userErrors[0].message}`);
    }
    return result.return;
  }

  // High-level orchestrator used by the MCP tool
  async exchangeItems(
    orderId,                  // full GID or numeric ID
    returnItems,              // array of { fulfillmentLineItemId, quantity }
    exchangeItems,            // array of { variantId, quantity }
    options = {}
  ) {
    // Normalise order ID to GID
    const gid = orderId.startsWith("gid://shopify/Order/")
      ? orderId
      : `gid://shopify/Order/${orderId}`;

    // 1. Get returnable fulfillments – we'll take the first one
    const edges = await this.getReturnableFulfillments(gid);
    if (!edges.length) {
      throw new Error("No returnable fulfillments found for this order.");
    }
    const returnableFulfillmentId = edges[0].node.id;

    // 2. Validate that the requested return line items exist in the fulfillment
    // (optional – you could skip and let Shopify return an error)

    // 3. Create return with exchange
    const createdReturn = await this.createReturnWithExchange(
      returnableFulfillmentId,
      returnItems,
      exchangeItems
    );

    // 4. Process the return
    const processedReturn = await this.processReturn(createdReturn.id);

    return {
      success: true,
      returnId: processedReturn.id,
      status: processedReturn.status,
      message: "Exchange completed successfully.",
    };
  }
}

// Utility function to format order transactions received from Shopify API
const formatOrderTransactions = (order, transactions) => {
  const successfulTransactions = transactions.filter(
    (t) => t.status === "success",
  );

  const authorizations = successfulTransactions.filter(
    (t) => t.kind === "authorization",
  );

  const captures = successfulTransactions.filter((t) => t.kind === "capture");

  const sales = successfulTransactions.filter((t) => t.kind === "sale");

  const refunds = successfulTransactions.filter((t) => t.kind === "refund");

  const voids = successfulTransactions.filter((t) => t.kind === "void");

  const successfulPaymentCount = captures.length + sales.length;

  const possibleDuplicateCharge = successfulPaymentCount > 1;

  let billingAssessment = "No billing issues detected.";

  if (possibleDuplicateCharge) {
    billingAssessment =
      "Multiple successful payment transactions detected. Further investigation may be required.";
  } else if (authorizations.length > 0 && captures.length > 0) {
    billingAssessment =
      "A single payment authorization and capture were found. This is a normal payment flow and does not indicate a duplicate charge.";
  } else if (refunds.length > 0) {
    billingAssessment = "A refund transaction was found for this order.";
  }

  return {
    order_id: order.order_number,

    financial_status: order.financial_status,

    payment_gateway: transactions[0]?.gateway || null,

    total_amount: order.current_total_price,

    currency: order.currency,

    transaction_summary: {
      authorizations: authorizations.length,
      captures: captures.length,
      sales: sales.length,
      refunds: refunds.length,
      voids: voids.length,
    },

    possible_duplicate_charge: possibleDuplicateCharge,

    billing_assessment: billingAssessment,

    transactions: transactions.map((t) => ({
      id: t.id,
      kind: t.kind,
      status: t.status,
      amount: t.amount,
      currency: t.currency,
      gateway: t.gateway,
      processed_at: t.processed_at,
      parent_id: t.parent_id,
    })),
  };
};

// Export environment variables and utility functions
module.exports = {
  // envs
  MCP_NAME,
  MCP_VERSION,
  SHOPIFY_BASE_URL,
  SHOPIFY_STOREFRONT_API_TOKEN,
  SHOPIFY_ACCESS_TOKEN,
  SMTP_USER,
  SMTP_PASS,
  BACKEND_API_URL,
  OPENAI_API_KEY,
  OPENAI_MODEL,
  // helpers
  callShopifyApi,
  callBackendAPI,
  formatProducts,
  extractSearchTerms,
  fetchRelatedProducts,
  getProductSortConfig,
  storeMetadata,
  logProductViewEvents,
  parseSpaceInput,
  extractDimensions,
  normalizeDims,
  getRelevanceScore,
  formatDiscounts,
  formatOrder,
  ShopifyOrderEditor,
  formatOrderTransactions,
  ShopifyExchangeManager,
};
