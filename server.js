#!/usr/bin/env node
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");
const axios = require("axios");
const dotenv = require("dotenv");
const express = require("express");
const https = require("https");
const nodemailer = require("nodemailer");
const cors = require("cors");
const nlp = require("compromise");


// Load environment variables from .env file
dotenv.config();

// Shopify API and SMTP Configuration
const SHOPIFY_BASE_URL = process.env.SHOPIFY_BASE_URL;
const SHOPIFY_STOREFRONT_API_TOKEN = process.env.SHOPIFY_STOREFRONT_API_TOKEN;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const BACKEND_API_URL = process.env.BACKEND_API_URL;
const ZENDESK_API_URL = process.env.ZENDESK_API_URL;
const ZENDESK_USERNAME = process.env.ZENDESK_USERNAME;
const ZENDESK_PASSWORD = process.env.ZENDESK_PASSWORD;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL 
// Validate environment variables
if (!SHOPIFY_BASE_URL) {
  console.error("ERROR: SHOPIFY_BASE_URL environment variable is required");
  process.exit(1);
}
if (!SHOPIFY_STOREFRONT_API_TOKEN) {
  console.error("ERROR: SHOPIFY_STOREFRONT_API_TOKEN environment variable is required");
  process.exit(1);
}
if (!SHOPIFY_ACCESS_TOKEN) {
  console.error("ERROR: SHOPIFY_ACCESS_TOKEN environment variable is required");
  process.exit(1);
}
if (!SMTP_USER) {
  console.error("ERROR: SMTP_USER environment variable is required");
  process.exit(1);
}
if (!SMTP_PASS) {
  console.error("ERROR: SMTP_PASS environment variable is required");
  process.exit(1);
}
if (!BACKEND_API_URL) {
  console.error("ERROR: BACKEND_API_URL environment variable is required");
  process.exit(1);
}
if (!ZENDESK_API_URL) {
  console.error("ERROR: ZENDESK_API_URL environment variable is required");
  process.exit(1);
}
if (!ZENDESK_USERNAME) {
  console.error("ERROR: ZENDESK_USERNAME environment variable is required");
  process.exit(1);
}
if (!ZENDESK_PASSWORD) {
  console.error("ERROR: ZENDESK_PASSWORD environment variable is required");
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error("ERROR: OPENAI_API_KEY environment variable is required");
  process.exit(1);
}
if (!OPENAI_MODEL) {
  console.error("ERROR: OPENAI_MODEL environment variable is required");
  process.exit(1);
}

// Memory store for sessions
const sessionStore = new Map();

// Setup SMTP
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
});

// Create an MCP server
const server = new McpServer({
  name: "shopify-mcp-server",
  version: "1.0.0",
  capabilities: {
    tools: true,
    resources: true,
  },
});

// Call Shopify APIs
async function callShopifyApi(method = "GET", endpoint="", data = null, isAdmin=false) {
  try {
    let url = isAdmin ? `${SHOPIFY_BASE_URL}/admin/api/2025-10/graphql.json` : `${SHOPIFY_BASE_URL}/api/2025-01/graphql.json`;
    if (endpoint){
      url = `${SHOPIFY_BASE_URL}${endpoint}`;
    }
    console.log(`Calling Shopify API: ${method} ${url}`);
    const headers = {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_API_TOKEN,
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN
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
    console.error("Shopify API Error:", error?.response?.data || error.message || error?.errors);
    throw error;
  }
}

// Calculate discount details for a product variant
const getVariantDiscount = (variant) => {
  const price = parseFloat(variant.priceV2?.amount || 0);
  const compare = parseFloat(variant.compareAtPriceV2?.amount || 0);

  if (compare && compare > price) {
    const discount = ((compare - price) / compare) * 100;

    return {
      original_price: compare,
      discounted_price: price,
      discount_percentage: Math.round(discount),
      savings: compare - price
    };
  }

  return null;
};

// Map ISO currency code to its symbol
const getCurrencySymbol = (code) => {
  const symbols = {
    USD: "$",
    INR: "₹",
  };
  return symbols[code] || (code ? `${code} ` : "");
};

// Format product data
const formatProducts = (products, session_id, store_code, full_details=false) => {
  return products.map(({ node }) => {

    const productId = node.id.split("/").pop();
    const productName = node.title;
    const productCategory = node?.category?.name;

    // Fire event for each product
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
      product_url: node.onlineStoreUrl || `${SHOPIFY_BASE_URL}/products/${node?.handle}`,
      variants: node.variants?.edges?.map(({ node: v }) => {
        const discount = getVariantDiscount(v);

        return {
          variant_id: v.id.split("/").pop(),
          title: v.title,

          price: {
            amount: `${getCurrencySymbol(v.priceV2?.currencyCode)}${v.priceV2?.amount || 0}`,
            currency: v.priceV2?.currencyCode || null
          },

          compare_at_price: v.compareAtPriceV2?.amount
            ? `${getCurrencySymbol(v.compareAtPriceV2?.currencyCode)}${v.compareAtPriceV2.amount}`
            : null,

          discount: discount,

          available_for_sale: v.availableForSale,
          options: v.selectedOptions
        };
      })
    };
  });
};

const getCancelStatus = (o) => {
  if (o.cancelled_at) return { allowed: false, reason: "Order already cancelled" };

  if (["fulfilled", "shipped"].includes(o.fulfillment_status)) {
    return { allowed: false, reason: "Order already shipped" };
  }

  if (["refunded", "voided"].includes(o.financial_status)) {
    return { allowed: false, reason: "Order already refunded" };
  }

  return { allowed: true };
};

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

// Format order data
const formatOrder = (o) => {
  const cancelStatus = getCancelStatus(o);
  const returnStatus = getReturnStatus(o);

  const formattedOrder = {
    order_id: o.order_number,
    email: o.email,
    financial_status: o.financial_status,
    fulfillment_status: o.fulfillment_status,
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
      line_item_id: item.id,
      name: item.name,
      quantity: item.quantity,
      price: `${getCurrencySymbol(o.presentment_currency)}${item.price || 0}`,
    }))
  };

  return formattedOrder;
};

// Helper function to call the backend api
const callBackendAPI = async (method, endpoint, data={}) =>{
  try{
    const url = `${BACKEND_API_URL}${endpoint}`;
    console.log("Backend api calling:", url);

    const config = {
      method,
      url,
      timeout: 15000,
      data: data,
    };

    const response = await axios(config);
    return response?.data?.data;
  }
  catch(err){
    console.error("Error calling backend API, error:", err?.response?.data);
    return null;
  }
};

// Fetch products metadata
const productsMetadata = async () => {
  try {
    const graphqlQuery = {query:
      `query {
        productTags(first: 250) {
          edges {
            node
          }
        }

        productTypes(first: 250) {
          edges {
            node
          }
        }

        collections(first: 250) {
          edges {
            node {
              title
            }
          }
        }

        products(first: 250) {
          edges {
            node {
              category {
                name
              }
            }
          }
        }
      }`
    };

    const result = await callShopifyApi("POST", "", graphqlQuery)

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
      result?.data?.collections?.edges?.map(
        (item) => item?.node?.title
      ) || [];

    const categories = [
      ...new Set(
        (
          result?.data?.products?.edges?.map(
            (item) => item?.node?.category?.name
          ) || []
        ).filter(Boolean)
      ),
    ];

    return {
      tags,
      types,
      collections,
      categories,
    };
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

// Extract search keywords
const extractSearchTerms = async (query) => {
  if (!query || typeof query !== "string") {
    return [];
  }

  try {
    const metadata = await productsMetadata();

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
      }
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

// Helper to extract appliesTo
const getAppliesTo = (discount) => {
  const items = discount?.customerGets?.items;

  if (!items) return { type: "all" };

  switch (items.__typename) {
    case "AllDiscountItems":
      return { type: "all" };

    case "DiscountProducts":
      return {
        type: "products",
        products: items.products?.edges?.map(e => ({
          // id: e.node.id.split("/").pop(),
          title: e.node.title
        })) || []
      };

    case "DiscountCollections":
      return {
        type: "collections",
        collections: items.collections?.edges?.map(e => ({
          // id: e.node.id.split("/").pop(),
          title: e.node.title
        })) || []
      };

    default:
      return { type: "unknown" };
  }
};

const getDiscountValue = (discount) => {
  const value = discount?.customerGets?.value;

  if (!value) return null;

  switch (value.__typename) {
    case "DiscountPercentage":
      const percentage = value.percentage * 100;
      return {
        type: "percentage",
        value: percentage,
        label: `${percentage}% OFF`
      };

    case "DiscountAmount":
      return {
        type: "fixed",
        value: parseFloat(value.amount?.amount || 0),
        currency: value.amount?.currencyCode,
        label: `₹${value.amount?.amount} OFF`
      };

    default:
      return null;
  }
};

// Main formatter
const formatDiscounts = (discounts) => {
  if (!discounts || !Array.isArray(discounts)) return [];

  const now = Date.now();

  const validDiscounts = discounts.filter(d => {
    const discount = d?.node?.discount;
    if (!discount) return false;

    const startsAt = discount.startsAt ? new Date(discount.startsAt).getTime() : null;
    const endsAt = discount.endsAt ? new Date(discount.endsAt).getTime() : null;

    if (startsAt && startsAt > now) return false;
    if (endsAt && endsAt < now) return false;

    return true;
  });

  return validDiscounts.map(d => {
    const discount = d.node.discount;
    const id = d.node.id.split("/").pop();
    const type = discount.__typename;

    const code =
      discount.codes?.edges?.[0]?.node?.code || null;

    const appliesTo = getAppliesTo(discount);

    let normalizedType = "unknown";
    let description = "";

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
      description += ` (Valid on ${appliesTo.collections.map(c => c.title).join(", ")})`;
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
      discountValue
    };
  });
};

// Fetch related products using product id
const fetchRelatedProducts = async (product_id) => {
  try{
    if (!product_id) return [];

    const graphqlQuery = {
      query: `query getRecommendations($productId: ID!) {
        productRecommendations(productId: $productId) {
          id
        }
      }`,
      variables: {
        productId: `gid://shopify/Product/${product_id}`
      }
    };

    // Call Shopify API
    const searchResponse = await callShopifyApi(
      "POST",
      "",
      graphqlQuery
    );

    const recommendations =
      searchResponse?.data?.productRecommendations || [];

    if (!recommendations.length) {
      return [];
    }

    // Extract clean product IDs
    const productIds = recommendations.map((product) =>
      product.id.replace("gid://shopify/Product/", "")
    );

    return productIds.slice(0, 4);
  }
  catch(error){
    console.log("Related product search getting error, Error:", error);
    return [];
  }
}

// Sorting options
const SortOption = Object.freeze({
  RELEVANCE: "relevance",
  PRICE_ASC: "price_asc",
  PRICE_DESC: "price_desc",
  NEWEST: "newest",
  BEST_SELLING: "best_selling",
});

// Mapping of sorting options to Shopify sort keys and order
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

// Helper to get Shopify sort arguments based on user-friendly sort key
const getProductSortArgs = (sortKey) => {
  if (!sortKey) return `, sortKey: ${SHOPIFY_SORT_MAPPING.relevance.sortKey}, reverse: ${SHOPIFY_SORT_MAPPING.relevance.reverse}`;

  const normalizedKey = String(sortKey).toLowerCase();
  const mapping = SHOPIFY_SORT_MAPPING[normalizedKey];
  if (!mapping) return "";
  return `, sortKey: ${mapping.sortKey}, reverse: ${mapping.reverse}`;
};


// Tool 1: Search products
server.tool(
  "search_products",
  `Search for products based on the user's query. 
  Returns a list of products with their details, including name, price, stock status, and image URL.

  Parameters:
  @param {string} query: The search query (product name, description, etc.)
  @param {boolean} is_single: Whether to return a single product or multiple products
  @param {string} session_id: Session ID
  @param {string} store_code: Store name or code
  @param {boolean} full_details: 
  `,
  {
    query: z
    .string()
    .describe("Search query (product name, description, etc.)"),
    session_id: z
      .string()
      .describe("Session ID"),
    store_code: z
      .string()
      .describe("Store name/code"),
    is_single: z
    .boolean()
    .optional()
    .describe("Whether to return a single product or multiple products"),
    full_details: z
      .boolean()
      .optional()
      .describe("Whether to return full product details including variants, images, and URLs. Defaults to false."),
  },
  async ({ query, session_id, store_code, is_single = false, full_details = false }) => {
    try {
      if (!query?.includes("gid://shopify/Product/")) {
        is_single = false;
      }

      const productFields = full_details ? `
        id 
        title
        handle 
        productType
        category {
          name
        }
        availableForSale 
        onlineStoreUrl 
        description 
        descriptionHtml

        images(first: 5) { 
        edges { 
        node { 
        url 
        altText
          } 
        }
          }

    priceRange {
    minVariantPrice {
        amount
        currencyCode
    }
    }

        variants(first: 20) {
          edges {
            node {
        id
        title
        priceV2 {
            amount
            currencyCode
        }
        compareAtPriceV2 {
            amount
            currencyCode
        }
        availableForSale
        quantityAvailable
        currentlyNotInStock
        selectedOptions {
            name
            value
        }
            }
          }
        }`
  : `
        id 
        title
        category {
          name
        }
        priceRange {
          minVariantPrice {
            amount
            currencyCode
          }
        }
        description 
        availableForSale`;

      const graphqlQuery = {
        query: is_single?
        `query getProductById($search: ID!) {
              product(id: $search) {
                ${productFields}
              }
            }`
          : `query getProducts($search: String!) {
              products(first: 5, query: $search) {
                edges {
                  node {
                    ${productFields}
                  }
                }
              }
            }
            `,
        variables: { 
          search: query
         }
      };

      // Call Shopify API to search products
      const searchResponse = await callShopifyApi("POST", "", graphqlQuery);

      if (!searchResponse?.data?.products?.edges && !is_single){
        return {
          content: [
            {
              type: "text",
              text: "No products found for the given query",
            },
          ],
          isError: true,
        };
      }

      if (is_single && !searchResponse?.data?.product){
        return {
          content: [
            {
              type: "text",
              text: "No product found for the given ID",
            },
          ],
          isError: true,
        };
      }

      const formattedProducts = formatProducts(
        !is_single ? searchResponse.data.products.edges : [{ node: searchResponse.data.product }],
        session_id,
        store_code,
        full_details
      );

      // BUILD FINAL RESPONSE
      const result = {
        products: formattedProducts,
      };

      if (result?.products?.length === 0){
        // Retry with keywords
        const keywords = await extractSearchTerms(query);
        console.log(`No products found for this query "${query}", retrying with keywords - [${keywords}]...`);

        for (q of keywords){
          const gQuery = {
            query: `query getProducts($search: String!) {
              products(first: 5, query: $search) {
                edges {
                  node {
                    ${productFields}
                  }
                }
              }
            }
            `,
            variables: {
              search: q
            }
          };

          const searchResponse = await callShopifyApi("POST", "", gQuery);

          if (searchResponse?.data?.products?.edges){
            const formattedProducts = formatProducts(
              searchResponse.data.products.edges,
              session_id,
              store_code,
              full_details
            );

            result.products = formattedProducts;
            break;
          }
        }
      };

      // Fetch related products
      if (result?.products && result?.products?.length > 0){
        // Existing product IDs
        const existingProductIds = result.products.map((p) =>
          String(p.id)
        );

        for (p of result?.products){
          console.log("Fetching related products for ID:", p.id);

          const relatedProducts = await fetchRelatedProducts(p.id);

          console.log(
            `Related products for ${p.id}:`,
            relatedProducts
          );

          if (relatedProducts && relatedProducts?.length > 0){
            // Remove:
            // 1. duplicate IDs
            // 2. IDs already present in products
            const cleanedRelatedProducts = [
              ...new Set(
                relatedProducts.filter(
                  (id) => !existingProductIds.includes(String(id))
                )
              )
            ];

            if (cleanedRelatedProducts.length > 0) {
              result.relatedProducts = cleanedRelatedProducts;
              break;
            }
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error searching products: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// UTILITY FUNCTIONS (Moved outside the tool for reusability)

/**
 * Converts any length unit to centimeters
 * @param {number} value - The numeric value to convert
 * @param {string} unit - The unit (cm, m, ft, feet, inch, in)
 * @returns {number|null} - Value in centimeters, or null if invalid
 */
const toCm = (value, unit) => {
  if (!value) return null;
  if (unit === "cm") return value;
  if (unit === "m") return value * 100;
  if (unit === "ft" || unit === "feet") return value * 30.48;
  if (unit === "inch" || unit === "in") return value * 2.54;
  return value;
};

/**
 * Extracts dimensions (length, width, height) from a product description
 * @param {string} description - The product description text
 * @returns {Object|null} - { length, width, height } in cm, or null if nothing found
 */
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

/**
 * Normalizes dimensions by filling in missing values
 * If only one dimension exists, it's used for both length and width
 * @param {Object} dims - Raw dimensions object from extractDimensions
 * @returns {Object|null} - Normalized { length, width } or null if both missing
 */
const normalizeDims = (dims) => {
  if (!dims) return null;

  let { length, width } = dims;

  if (!length && width) length = width;
  if (!width && length) width = length;

  if (!length && !width) return null;

  return { length, width };
};

/**
 * Calculates a relevance score for a product based on its suitability for small spaces
 * @param {Object} product - The product object
 * @param {Object} dims - Normalized dimensions { length, width }
 * @returns {number} - Relevance score (higher = better fit for small spaces)
 */
const getRelevanceScore = (product, dims) => {
  let score = 0;

  const title = (product.title || "").toLowerCase();

  // Good for small spaces
  if (title.includes("table") || title.includes("side") || title.includes("stool")) score += 3;
  if (title.includes("wall") || title.includes("shelf")) score += 4;

  // Bad for small spaces
  if (title.includes("sofa") || title.includes("bed") || title.includes("wardrobe")) score -= 5;
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

/**
 * Parses and validates space input, converting to centimeters
 * @param {Object} space - Raw space object from tool input
 * @returns {Object|null} - { widthCm, lengthCm, isValid } or null if invalid
 */
const parseSpaceInput = (space) => {
  if (!space || typeof space !== 'object') {
    console.warn('Invalid space object:', space);
    return null;
  }

  const width = typeof space.width === 'number' ? space.width : parseFloat(space.width);
  const length = typeof space.length === 'number' ? space.length : parseFloat(space.length);
  const unit = space.unit?.toLowerCase();

  if (isNaN(width) || isNaN(length) || !unit) {
    console.warn('Invalid dimensions in space:', space);
    return null;
  }

  const widthCm = toCm(width, unit);
  const lengthCm = toCm(length, unit);

  return {
    widthCm,
    lengthCm,
    isValid: true,
    original: { width, length, unit }
  };
};

// TOOL 11: Filter products by space

server.tool(
  "filter_products_by_space",
  `Filters and ranks products based on available space by extracting dimensions from product descriptions.
   Returns products in the same format as search_products.`,
  {
    products: z.array(
      z.object({
        id: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        tags: z.string().optional(),
        productType: z.string().optional(),
        availableForSale: z.boolean().optional(),
        onlineStoreUrl: z.string().optional(),
        priceRange: z.any().optional(),
        variants: z.any().optional(),
        images: z.any().optional()
      })
    ),
    space: z.object({
      width: z.number(),
      length: z.number(),
      unit: z.string().describe("cm | m | ft | inch")
    }),
    session_id: z.string()
  },
  
  async ({ products, space, session_id }) => {
    try {
      // Parse and validate space input
      const parsedSpace = parseSpaceInput(space);
      
      if (!parsedSpace) {
        console.warn('filter_products_by_space called with invalid space:', space);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ products: products.slice(0, 5) }, null, 2),
          }],
        };
      }

      const { widthCm: spaceWidthCm, lengthCm: spaceLengthCm } = parsedSpace;

      // Process each product
      const scoredProducts = [];

      for (const product of products) {
        const desc = product.description || "";

        // Extract and normalize dimensions from description
        let dims = extractDimensions(desc);
        dims = normalizeDims(dims);

        let fitType = "near";

        if (dims) {
          // Check if product fits (with rotation support)
          const fits =
            (dims.length <= spaceLengthCm && dims.width <= spaceWidthCm) ||
            (dims.width <= spaceLengthCm && dims.length <= spaceWidthCm);

          // Check if product fits within tolerance (~30%)
          const toleranceFits =
            (dims.length <= spaceLengthCm * 1.3 && dims.width <= spaceWidthCm * 1.3) ||
            (dims.width <= spaceLengthCm * 1.3 && dims.length <= spaceWidthCm * 1.3);

          if (fits) fitType = "fit";
          else if (toleranceFits) fitType = "near";
          else fitType = "oversized";
        }

        const score = getRelevanceScore(product, dims);

        scoredProducts.push({
          product,
          score,
          fitType
        });
      }

      // Sort products by fit quality, then by relevance score
      const sortedProducts = scoredProducts
        .sort((a, b) => {
          const fitPriority = { fit: 3, near: 2, oversized: 1 };

          if (fitPriority[b.fitType] !== fitPriority[a.fitType]) {
            return fitPriority[b.fitType] - fitPriority[a.fitType];
          }

          return b.score - a.score;
        })
        .map(p => p.product);

      // Return top 5 products (or fallback to top 3 if none passed filters)
      let finalProducts = sortedProducts.slice(0, 5);

      if (finalProducts.length === 0) {
        finalProducts = products.slice(0, 3);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ products: finalProducts }, null, 2),
          },
        ],
      };

    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error filtering products: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool 2: Get order details
server.tool(
  "get_order_detail",
  `Fetch a specific order by order number and email.
  Returns a single order object.

  Parameters:
  @param {string} email: Order identifier (e.g. "test@example.com")
  @param {string} order_id: Order identifier (e.g. "1026")
  @param {string} session_id - Session identifier
  @param {string} customer_id - Customer ID
  `,
  {
    email: z
      .string()
      .describe("Order email (e.g. 'test@example.com')"),
    order_id: z
      .string()
      .describe("Order ID (e.g. '1026')"),
    session_id: z.string().describe("Session identifier"),
    customer_id: z.string().describe("Customer ID"),
  },
  async ({ email, order_id, session_id, customer_id="" }) => {
    if (!customer_id){
      const verificationStatus = await callBackendAPI("POST", "/chat/email/verify-status/", {"thread_id": session_id, "email": email});

      if (!verificationStatus && !verificationStatus?.is_verified){
        return {
          content: [
            { type: "text", text: "Please verify your email before accessing order details." },
          ],
          isError: true,
        };
      }
    }

    try {
      const response = await callShopifyApi(
        "GET",
        `/admin/api/2024-04/orders.json?email=${encodeURIComponent(email)}&status=any`,
      );

      // No orders
      if (!response || !Array.isArray(response.orders)){
        return {
          content: [
            {
              type: "text",
              text: "We couldn’t found your order with this email.",
            },
          ],
          isError: true,
        };
      }

      const orders = response?.orders;

      const currentOrder = orders.find(o => o?.order_number == order_id);

      if (!currentOrder) {
        return {
          content: [
            {
              type: "text",
              text: `We couldn’t locate order #${order_id}. Please verify the order ID and try again.`,
            },
          ],
          isError: true,
        };
      }

      const formattedOrder = formatOrder(currentOrder);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(formattedOrder, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching order detail: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool 3: Cart Details
server.tool(
  "get_cart_details",
  `Retrieve cart details using a Shopify Storefront Cart ID.

  This tool returns cart items, pricing summary, and checkout URL.
  It must only be used when a Cart ID already exists in context.

  Parameters:
  @param {string} cart_id - Shopify Storefront Cart ID (gid://shopify/Cart/...)
  @param {string} session_id: Session ID
  @param {string} store_code: Store name or code
  `,
  {
    cart_id: z
      .string()
      .startsWith("gid://shopify/Cart/")
      .describe("Shopify Storefront Cart ID"),
    session_id: z
      .string()
      .describe("Session ID"),
    store_code: z
      .string()
      .describe("Store name/code"),
  },
  async ({ cart_id, session_id, store_code }) => {
    try {
      const graphqlQuery = {
        query:
        `query getCart($cartId: ID!) {
          cart(id: $cartId) {
            id
            checkoutUrl
            lines(first: 50) {
              edges {
                node {
                  id
                  quantity
                  merchandise {
                    ... on ProductVariant {
                      id
                      title
                      availableForSale
                      price {
                        amount
                        currencyCode
                      }
                      product {
                        title
                      }
                    }
                  }
                }
              }
            }
            cost {
              subtotalAmount {
                amount
                currencyCode
              }
              totalTaxAmount {
                amount
                currencyCode
              }
              totalAmount {
                amount
                currencyCode
              }
            }
          }
        }`,
        variables: {
          cartId: cart_id
        }
      };

      const response = await callShopifyApi(
        "POST",
        "",
        graphqlQuery,
      );

      const cart = response?.data?.cart;

      callBackendAPI("POST", "/chat/bot-events/", {"thread_id": session_id, "event_type": "checkout_link", store_code: store_code});

      if (!cart) {
        return {
          content: [
            {
              type: "text",
              text: "Unable to retrieve cart details at the moment.",
            },
          ],
          isError: true,
        };
      }

      // Normalize cart items
      const items = cart.lines.edges.map(({ node }) => ({
        lineId: node.id,
        productName: node.merchandise.product.title,
        variantTitle: node.merchandise.title,
        quantity: node.quantity,
        price: `${getCurrencySymbol(node.merchandise.price?.currencyCode)}${node.merchandise.price?.amount || 0}`,
        currency: node.merchandise.price.currencyCode,
        inStock: node.merchandise.availableForSale,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              cartID: cart.id,
              items,
              subtotal: `${getCurrencySymbol(cart.cost.subtotalAmount?.currencyCode)}${cart.cost.subtotalAmount?.amount || 0}`,
              tax: `${getCurrencySymbol(cart.cost.totalTaxAmount?.currencyCode)}${cart.cost.totalTaxAmount?.amount || 0}`,
              total: `${getCurrencySymbol(cart.cost.totalAmount?.currencyCode)}${cart.cost.totalAmount?.amount || 0}`,
              checkoutUrl: cart.checkoutUrl,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      console.error("Get cart details error:", error);
      return {
        content: [
          {
            type: "text",
            text: "Something went wrong while fetching your cart.",
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool 4: Add to cart
server.tool(
  "add_to_cart",
  `Add a product variant to cart.
  If cart_id is not provided, a new cart will be created first.

  Parameters:
  @param {string} variant_id: Shopify ProductVariant ID
  @param {number} quantity: Quantity to add
  @param {string} session_id: Session ID
  @param {string} [cart_id]: Existing cart ID (optional)
  @param {string} store_code: Store name or code
  `,
  {
    variant_id: z
      .string()
      .describe("Shopify ProductVariant ID (gid://shopify/ProductVariant/...)"),
    quantity: z
      .number()
      .min(1)
      .describe("Quantity to add"),
    session_id: z
      .string()
      .describe("Session ID"),
    cart_id: z
      .string()
      .optional()
      .describe("Existing cart ID (optional)"),
    store_code: z
      .string()
      .describe("Store name/code"),
  },
  async ({ variant_id, quantity, session_id, cart_id, store_code }) => {
    try {
      let cartId = cart_id;

      /* --------------------------------------------------
         STEP 1: Create cart if not exists
      -------------------------------------------------- */
      if (!cartId) {
        const createCartQuery = {
          query: `
            mutation cartCreate {
              cartCreate {
                cart {
                  id
                  checkoutUrl
                }
              }
            }
          `
        };

        const createCartResponse = await callShopifyApi(
          "POST",
          "",
          createCartQuery,
        );

        cartId = createCartResponse?.data?.cartCreate?.cart?.id;

        if (!cartId) {
          return {
            content: [
              {
                type: "text",
                text: "Failed to create cart",
              },
            ],
            isError: true,
          };
        }
      }

      /* --------------------------------------------------
         STEP 2: Add item to cart
      -------------------------------------------------- */
      const addToCartQuery = {
        query: `
          mutation cartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
            cartLinesAdd(cartId: $cartId, lines: $lines) {
              cart {
                id
                checkoutUrl
                lines(first: 20) {
                  edges {
                    node {
                      id
                      quantity
                      merchandise {
                        ... on ProductVariant {
                          id
                          title
                          price {
                            amount
                            currencyCode
                          }
                        }
                      }
                    }
                  }
                }
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        variables: {
          cartId,
          lines: [
            {
              merchandiseId: variant_id,
              quantity
            }
          ]
        }
      };

      const addResponse = await callShopifyApi(
        "POST",
        "",
        addToCartQuery,
      );

      const cart = addResponse?.data?.cartLinesAdd?.cart;
      const errors = addResponse?.data?.cartLinesAdd?.userErrors || [];

      if (!cart) {
        return {
            content: [
              {
                type: "text",
                text: "Failed to add item to cart",
              },
            ],
            isError: true,
          };
      }

      /* --------------------------------------------------
         STEP 3: Normalize cart response
      -------------------------------------------------- */
      const formattedCart = {
        cart_id: cart.id,
        checkout_url: cart.checkoutUrl,
        items: cart.lines.edges.map(({ node }) => ({
          cart_line_id: node.id,
          variant_id: node.merchandise.id,
          title: node.merchandise.title,
          quantity: node.quantity,
          price: `${getCurrencySymbol(node?.merchandise?.price?.currencyCode)}${node?.merchandise?.price?.amount || 0}`
        }))
      };

      const addedItem = formattedCart.items.find(i => i.variant_id === variant_id);

      callBackendAPI("POST", "/chat/bot-events/", {"thread_id": session_id, "event_type": "add_to_cart", store_code: store_code});

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                cart: formattedCart,
                userErrors: errors
              },
              null,
              2
            )
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error adding to cart: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
);

// Tool 5: Update cart item quantity
server.tool(
  "update_cart_item",
  `Update quantity of a cart line item.

  Parameters:
  @param {string} cart_id: Shopify Cart ID
  @param {string} cart_line_id: CartLine ID
  @param {number} quantity: New quantity
  @param {string} session_id: Session ID
  `,
  {
    cart_id: z.string().describe("Shopify Cart ID"),
    cart_line_id: z.string().describe("CartLine ID"),
    quantity: z.number().min(1).describe("New quantity"),
    session_id: z.string().describe("Session ID"),
  },
  async ({ cart_id, cart_line_id, quantity, session_id }) => {
    try {
      const graphqlQuery = {
        query: `
          mutation cartLinesUpdate(
            $cartId: ID!,
            $lines: [CartLineUpdateInput!]!
          ) {
            cartLinesUpdate(cartId: $cartId, lines: $lines) {
              cart {
                id
                checkoutUrl
                lines(first: 20) {
                  edges {
                    node {
                      id
                      quantity
                      merchandise {
                        ... on ProductVariant {
                          id
                          title
                          price {
                            amount
                            currencyCode
                          }
                        }
                      }
                    }
                  }
                }
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        variables: {
          cartId: cart_id,
          lines: [
            {
              id: cart_line_id,
              quantity
            }
          ]
        }
      };

      const response = await callShopifyApi(
        "POST",
        "",
        graphqlQuery,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.data.cartLinesUpdate, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error updating cart item: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
);

// Tool 6: Remove item from cart
server.tool(
  "remove_from_cart",
  `Remove an item from cart.

  Parameters:
  @param {string} cart_id: Shopify Cart ID
  @param {string} cart_line_id: CartLine ID to remove
  @param {string} session_id: Session ID
  `,
  {
    cart_id: z.string().describe("Shopify Cart ID"),
    cart_line_id: z.string().describe("CartLine ID"),
    session_id: z.string().describe("Session ID"),
  },
  async ({ cart_id, cart_line_id, session_id }) => {
    try {
      const graphqlQuery = {
        query: `
          mutation cartLinesRemove(
            $cartId: ID!,
            $lineIds: [ID!]!
          ) {
            cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {
              cart {
                id
                checkoutUrl
                lines(first: 20) {
                  edges {
                    node {
                      id
                      quantity
                      merchandise {
                        ... on ProductVariant {
                          title
                        }
                      }
                    }
                  }
                }
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        variables: {
          cartId: cart_id,
          lineIds: [cart_line_id]
        }
      };

      const response = await callShopifyApi(
        "POST",
        "",
        graphqlQuery,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.data.cartLinesRemove, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error removing cart item: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
);

// Tool 7: Send OTP
server.tool(
  "send_otp",
  `Send a verification OTP to the provided email.
  This tool is strictly used for order tracking verification.

  Parameters:
  @param {string} email - User email to receive OTP
  @param {string} session_id - Unique session identifier
  `,
  {
    email: z.string().email().describe("User email address"),
    session_id: z.string().min(5).describe("Unique session identifier"),
  },
  async ({ email, session_id }) => {
    try {
      const verificationStatus = await callBackendAPI("POST", "/chat/email/verify-status/", {"thread_id": session_id, "email": email});
      if (verificationStatus && verificationStatus?.is_verified){
        return {
          content: [
            { type: "text", text: "Your email is already verified." },
          ],
          isError: false,
        };
      }

      // Check customer existence (Admin API only)
      const customerResponse = await callShopifyApi(
        "GET",
        `/admin/api/2024-01/customers/search.json?query=email:${encodeURIComponent(email)}`
      );

      // Prevent email enumeration
      if (!customerResponse?.customers?.length || customerResponse?.customers?.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                "No account found with this email.",
            },
          ],
        };
      }

      const otpResponse = await callBackendAPI("POST", "/chat/otp/generate/", {"thread_id": session_id, "email": email});

      if (!otpResponse || !otpResponse?.otp){
        return {
          content: [
            { type: "text", text: "Failed to send otp, please try again." },
          ],
          isError: true,
        };
      }

      // Send email
      await transporter.sendMail({
        from: `"Shopify Support" <${process.env.SMTP_USER}>`,
        to: email,
        subject: "Your verification code",
        text: `Your verification code is ${otpResponse?.otp}. It will expire in ${otpResponse?.expires_in_seconds} seconds.`,
      });

      return {
        content: [
          {
            type: "text",
            text:
              // "If an account exists with this email, a verification code has been sent.",
              "A 6-digit verification code has been sent to your email.",
          },
        ],
      };
    } catch (error) {
      console.error("Send OTP error:", error);
      return {
        content: [
          { type: "text", text: "Unable to send verification code right now." },
        ],
        isError: true,
      };
    }
  }
);

// Tool 8: Verify OTP
server.tool(
  "verify_otp",
  `Verify an OTP sent for order tracking email verification.

  Parameters:
  @param {string} email - User email used for verification
  @param {string} otp_code - 6 digit OTP
  @param {string} session_id - Session identifier
  `,
  {
    email: z.string().email().describe("User email"),
    otp_code: z.string().length(6).describe("6 digit OTP"),
    session_id: z.string().describe("Session identifier"),
  },
  async ({ email, otp_code, session_id }) => {
    try {
      const payload = {
        "thread_id": session_id,
        "email": email,
        "otp": otp_code
      }
      const verificationResponse = await callBackendAPI("POST", "/chat/otp/verify/", payload);

      if (!verificationResponse || !verificationResponse?.is_verified) {
        return {
          content: [
            { type: "text", text: "Invalid or expired verification code." },
          ],
          isError: true,
        };
      }

      return {
        content: [
          { type: "text", text: "Verification successful." },
        ],
        verified: true,
      };
    } catch (error) {
      console.error("Verify OTP error:", error);
      return {
        content: [
          { type: "text", text: "Verification failed. Please try again." },
        ],
        isError: true,
      };
    }
  }
);

// Tool 9: Order Cancellation
server.tool(
  "order_cancel",
  `Cancel an order for a user.

  Parameters:
  @param {string} email - User email
  @param {string} order_id - Order ID
  @param {string} cancel_reason - Reason for cancellation
  @param {string} session_id - Session identifier
  `,
  {
    email: z.string().email().describe("User email"),
    order_id: z.string().describe("Order ID (e.g. '1026')"),
    cancel_reason: z.string().max(255).optional().describe("Reason for cancellation"),
    session_id: z.string().describe("Session identifier"),
  },
  async ({ email, order_id, cancel_reason, session_id }) => {
    try {
      const record = sessionStore.get(session_id);

      if (!record || !record.emails.includes(email) || Date.now() > record.expires) {
        return {
          content: [
            { type: "text", text: "Invalid or expired session. Please verify email with otp verification." },
          ],
          isError: true,
        };
      }

      // Fetch order details
      const order_query = `email:${email} AND name:#${order_id}`;

      const graphqlQuery = {
        query: `
          query GetOrder($query: String!) {
            orders(first: 1, query: $query) {
              edges {
                node {
                  id cancelledAt legacyResourceId
                }
              }
            }
          }
        `,
        variables: {
          query: order_query
        }
      };

      const response = await callShopifyApi(
        "POST",
        "",
        graphqlQuery,
        true
      );

      const edge = response?.data?.orders?.edges?.[0];

      if (!edge) {
        return {
          content: [
            {
              type: "text",
              text: "No order found for the given identifier",
            },
          ],
          isError: true,
        };
      }

      const o = edge.node;

      // Check if already cancelled
      if (o?.cancelledAt) {
        return {
          content: [
            {
              type: "text",
              text: "Order is already cancelled.",
            },
          ],
        };
      }

      // Cancel the order (Admin API)
      const endpoint = `/admin/api/2024-04/orders/${o.legacyResourceId}/cancel.json`;

      const cancelResponse = await callShopifyApi(
        "POST",
        endpoint,
        {
          reason: cancel_reason || "customer",
        },
        true
      );

      if (cancelResponse?.order?.cancelled_at){
        return {
          content: [
            { type: "text", text: "Order cancelled successfully." },
          ],
        };
      }
      else{
        return {
          content: [
            {
              type: "text",
              text: `Order cancellation failed: ${cancelResponse?.errors?.[0]?.message || "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    } catch (error) {
      console.error("Verify OTP error:", error);
      return {
        content: [
          { type: "text", text: "Verification failed. Please try again." },
        ],
        isError: true,
      };
    }
  }
);

// Tool 10: Order Return
server.tool(
  "order_return",
  `Create a return request for an order.

  Parameters:
  @param {string} email - User email
  @param {string} order_id - Order ID
  @param {Array} return_items - Items to return (line_item_id + quantity)
  @param {string} return_reason - Reason for return (optional)
  @param {string} session_id - Session identifier
  `,
  {
    email: z.string().email().describe("User email"),
    order_id: z.string().describe("Order ID (e.g. '1033')"),
    return_items: z.array(
      z.object({
        line_item_id: z.string().describe("Shopify line item ID"),
        quantity: z.number().min(1).describe("Quantity to return"),
      })
    ).min(1).describe("Items to return"),
    return_reason: z.string().max(255).optional().describe("Reason for return"),
    session_id: z.string().describe("Session identifier"),
  },
  async ({ email, order_id, return_items, return_reason, session_id }) => {
    try {
      /* -------------------- Session validation -------------------- */
      const record = sessionStore.get(session_id);

      if (!record || !record.emails.includes(email) || Date.now() > record.expires) {
        return {
          content: [
            { type: "text", text: "Invalid or expired session. Please verify your email again." },
          ],
          isError: true,
        };
      }

      /* -------------------- Fetch order -------------------- */
      const order_query = `email:${email} AND name:#${order_id}`;

      const graphqlQuery = {
        query: `
          query GetOrder($query: String!) {
            orders(first: 1, query: $query) {
              edges {
                node {
                  id
                  legacyResourceId
                  displayFulfillmentStatus
                  displayFinancialStatus
                  cancelledAt
                  lineItems(first: 10) {
                    edges {
                      node {
                        id
                        title
                        originalUnitPriceSet {
                            shopMoney {
                                amount
                                currencyCode
                            }
                        }
                        discountedUnitPriceSet {
                            shopMoney {
                                amount
                                currencyCode
                            }
                        }
                        quantity
                        fulfillableQuantity
                      }
                    }
                  }
                }
              }
            }
          }
        `,
        variables: { query: order_query }
      };

      const response = await callShopifyApi("POST", "", graphqlQuery, true);
      const edge = response?.data?.orders?.edges?.[0];

      if (!edge) {
        return {
          content: [{ type: "text", text: "No order found for the given identifier." }],
          isError: true,
        };
      }

      const order = edge.node;

      /* -------------------- Eligibility checks -------------------- */

      // Already cancelled
      if (order.cancelledAt) {
        return {
          content: [{ type: "text", text: "This order has already been cancelled and cannot be returned." }],
          isError: true,
        };
      }

      // Not fulfilled → return not allowed
      if (order.fulfillmentStatus !== "FULFILLED") {
        return {
          content: [
            {
              type: "text",
              text: "This order has not been delivered yet. You can cancel the order instead of returning it.",
            },
          ],
          // isError: true,
        };
      }

      /* -------------------- Validate return items -------------------- */
      const validLineItems = order.lineItems.edges.map(e => e.node);

      for (const item of return_items) {
        const li = validLineItems.find(
          l => String(l.id) === String(item.line_item_id)
        );

        if (!li) {
          return {
            content: [{ type: "text", text: "One or more selected items are invalid for return." }],
            isError: true,
          };
        }

        if (item.quantity > li.quantity) {
          return {
            content: [{ type: "text", text: "Return quantity exceeds purchased quantity." }],
            isError: true,
          };
        }
      }

      /* -------------------- Create return -------------------- */
      const returnMutation = {
        query: `
          mutation returnCreate($input: ReturnCreateInput!) {
            returnCreate(input: $input) {
              return {
                id
                status
              }
              userErrors {
                message
              }
            }
          }
        `,
        variables: {
          input: {
            orderId: order.id,
            returnLineItems: return_items.map(item => ({
              lineItemId: item.line_item_id,
              quantity: item.quantity,
            })),
            note: return_reason || "Customer initiated return",
          },
        },
      };

      const returnResponse = await callShopifyApi("POST", "", returnMutation, true);
      const errors = returnResponse?.data?.returnCreate?.userErrors;

      if (errors && errors.length > 0) {
        return {
          content: [{ type: "text", text: errors[0].message }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: "Return request created successfully. Further instructions will be shared shortly.",
          },
        ],
      };
    } catch (error) {
      console.error("Order return error:", error);
      return {
        content: [{ type: "text", text: "Unable to create return at the moment. Please try again later." }],
        isError: true,
      };
    }
  }
);

// Tool 11: Create Support Ticket
server.tool(
  "create_support_ticket",
  `Create a support ticket for a customer issue.

  Behavior:
  1. Check if requester exists by email.
  2. If not found, create new user.
  3. Create support ticket linked to requester.
  4. Return ticket ID in response.

  Parameters:
  - email (string): Customer email address
  - subject (string): Ticket subject line
  - description (string): Detailed problem description
  - session_id (string): Session ID
  - store_code (string): Store Code
  `,
  {
    email: z.string().email().describe("Customer email address"),
    subject: z.string().min(3).describe("Short ticket subject"),
    description: z.string().min(5).describe("Detailed issue description"),
    session_id: z.string().describe("Session ID"),
    store_code: z.string().describe("Store Code"),
  },
  async ({ email, subject, description, session_id, store_code }) => {
    try {
      const authConfig = {
        auth: {
          username: `${ZENDESK_USERNAME}/token`,
          password: ZENDESK_PASSWORD,
        },
        headers: {
          "Content-Type": "application/json",
        },
      };

      let requesterId = null;

      // Search existing user
      const searchResponse = await axios.get(
        `${ZENDESK_API_URL}/users/search.json?query=${encodeURIComponent(email)}`,
        authConfig
      );

      if (searchResponse?.data?.users?.length > 0) {
        requesterId = searchResponse.data.users[0].id;
      };

      // Create user if not found
      if (!requesterId) {
        const userResponse = await axios.post(
          `${ZENDESK_API_URL}/users.json`,
          {
            user: {
              name: email.split("@")[0],
              email: email,
            },
          },
          authConfig
        );

        requesterId = userResponse?.data?.user?.id;
      }

      if (!requesterId) {
        return {
          content: [
            { type: "text", text: "Unable to create requester user." },
          ],
          isError: true,
        };
      }

      // Create ticket
      const ticketResponse = await axios.post(
        `${ZENDESK_API_URL}/tickets.json`,
        {
          ticket: {
            subject: subject,
            comment: {
              body: description,
            },
            requester_id: requesterId,
            priority: "normal",
          },
        },
        authConfig
      );

      const ticketId = ticketResponse?.data?.ticket?.id;

      if (!ticketId) {
        return {
          content: [
            { type: "text", text: "Failed to create support ticket." },
          ],
          isError: true,
        };
      }

      const payload = {
        "requester_id": requesterId,
        "subject": subject,
        "description": description,
        "thread_id": session_id,
        "store_code": store_code,
        "ticket_id": ticketId,
      };
      callBackendAPI("POST", "/support/threads/session_id/tickets/", payload);

      // Success Response
      return {
        content: [
          {
            type: "text",
            text: `Support ticket #${ticketId} created successfully. Our team will contact you soon.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error creating support ticket: ${error.message}` }],
        isError: true,
      };
    }
  }
);
// Tool 12: Get products by ID or IDs
server.tool(
  "get_products_by_ids",
  `Fetch one or more products by their Shopify product IDs.
  Returns the same shape as search_products.

  Use this when you already have product IDs (e.g. from a previous search,
  a cart payload, or user-supplied links) and need full product details.

  Parameters:
  @param {string[]} product_ids  One or more numeric or GID product IDs
  @param {string}   session_id   Session ID
  @param {string}   store_code   Store name or code
  `,
  {
    product_ids: z
      .array(z.string())
      .min(1)
      .describe(
        "One or more product IDs. Accepts plain numeric IDs ('123456789') " +
        "or full GIDs ('gid://shopify/Product/123456789')."
      ),
    session_id: z.string().describe("Session ID"),
    store_code: z.string().describe("Store name/code"),
  },
  async ({ product_ids, session_id, store_code }) => {
    try {
      // Deduplicate + normalise to full GID
      const gids = [...new Set(
        product_ids.map((id) =>
          id.startsWith("gid://shopify/Product/")
            ? id
            : `gid://shopify/Product/${id}`
        )
      )];

      const singleProductQuery = (gid) => ({
        query: `query getProductById($id: ID!) {
          product(id: $id) {
            id title handle productType category { name } availableForSale onlineStoreUrl
            description descriptionHtml
            images(first: 5) { edges { node { url altText } } }
            priceRange { minVariantPrice { amount currencyCode } }
            variants(first: 20) {
              edges {
                node {
                  id title
                  priceV2 { amount currencyCode }
                  compareAtPriceV2 { amount currencyCode }
                  availableForSale quantityAvailable currentlyNotInStock
                  selectedOptions { name value }
                }
              }
            }
          }
        }`,
        variables: { id: gid },
      });

      const fetchOne = (gid) =>
        callShopifyApi("POST", "", singleProductQuery(gid))
          .then((res) => res?.data?.product ?? null);

      const CHUNK = 5;
      const results = [];
      const missing = [];

      for (let i = 0; i < gids.length; i += CHUNK) {
        const chunk = gids.slice(i, i + CHUNK);
        const settled = await Promise.allSettled(chunk.map(fetchOne));
        settled.forEach((s, idx) => {
          if (s.status === "fulfilled" && s.value) results.push(s.value);
          else missing.push(chunk[idx]); // tracks not-found + errored IDs
        });
      }

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "No products found for the provided IDs." }],
          isError: true,
        };
      }

      const formattedProducts = formatProducts(
        results.map((node) => ({ node })),
        session_id,
        store_code,
        true
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            products: formattedProducts,
            ...(missing.length > 0 && { missing_ids: missing }),
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error fetching products by ID: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool 13: List available discounts
server.tool(
  "list_available_discounts",
  `List all available discounts from the store.
  Returns active discount codes, automatic discounts (price rules), and their details.
  `,
  {
  },
  async () => {
    try {
      const graphqlQuery = {
        query: `{
                discountNodes(first: 20) {
                  edges {
                    node {
                      id
                      discount {
                        __typename

                        ... on DiscountAutomaticBasic {
                          title
                          startsAt
                          endsAt

                          customerGets {
                            value {
                              __typename

                              ... on DiscountPercentage {
                                percentage
                              }

                              ... on DiscountAmount {
                                amount {
                                  amount
                                  currencyCode
                                }
                              }
                            }

                            items {
                              __typename

                              ... on AllDiscountItems {
                                allItems
                              }

                              ... on DiscountProducts {
                                products(first: 10) {
                                  edges {
                                    node {
                                      id
                                      title
                                    }
                                  }
                                }
                              }

                              ... on DiscountCollections {
                                collections(first: 10) {
                                  edges {
                                    node {
                                      id
                                      title
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }

                        ... on DiscountCodeBasic {
                          title
                          startsAt
                          endsAt

                          codes(first: 5) {
                            edges {
                              node {
                                code
                              }
                            }
                          }

                          customerGets {
                            value {
                              __typename

                              ... on DiscountPercentage {
                                percentage
                              }

                              ... on DiscountAmount {
                                amount {
                                  amount
                                  currencyCode
                                }
                              }
                            }

                            items {
                              __typename

                              ... on AllDiscountItems {
                                allItems
                              }

                              ... on DiscountProducts {
                                products(first: 10) {
                                  edges {
                                    node {
                                      id
                                      title
                                    }
                                  }
                                }
                              }

                              ... on DiscountCollections {
                                collections(first: 10) {
                                  edges {
                                    node {
                                      id
                                      title
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }

                        ... on DiscountAutomaticBxgy {
                          title
                          startsAt
                          endsAt

                          customerGets {
                            value {
                              __typename

                              ... on DiscountPercentage {
                                percentage
                              }

                              ... on DiscountAmount {
                                amount {
                                  amount
                                  currencyCode
                                }
                              }
                            }

                            items {
                              __typename

                              ... on DiscountProducts {
                                products(first: 10) {
                                  edges {
                                    node {
                                      id
                                      title
                                    }
                                  }
                                }
                              }

                              ... on DiscountCollections {
                                collections(first: 10) {
                                  edges {
                                    node {
                                      id
                                      title
                                    }
                                  }
                                }
                              }
                            }
                          }

                          customerBuys {
                            value {
                              ... on DiscountQuantity {
                                quantity
                              }
                            }
                          }
                        }

                        ... on DiscountAutomaticFreeShipping {
                          title
                          startsAt
                          endsAt
                        }
                      }
                    }
                  }
                }
              }`
      };

      const response = await callShopifyApi("POST", "", graphqlQuery, true);

      if (!response?.data?.discountNodes?.edges || response?.data?.discountNodes?.edges?.length < 1) {
        return {
          content: [{
            type: "text",
            text: "No discounts found.",
          }],
        };
      }

      const discounts = formatDiscounts(response?.data?.discountNodes?.edges);

      if (discounts.length === 0) {
        return {
          content: [{
            type: "text",
            text: "No discounts found.",
          }],
        };
      }

      // Sort by end date (active first)
      discounts.sort((a, b) => new Date(b.ends_at) - new Date(a.ends_at));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total: discounts.length,
            discounts: discounts,
          }, null, 2),
        }],
      };
    } catch (error) {
      console.error("Error fetching discounts:", error);
      return {
        content: [{ type: "text", text: `Error fetching available discounts: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool 14: Get store metadata info
server.tool(
  "get_store_meta_info",
  `Fetch metadata about the store's product catalog.
  Returns product tags, types, collections, and categories available in the store.
  `,
  async () => {
    try {
      const metadata = await productsMetadata();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(metadata, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching store metadata: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool 15: Get products sorted by Shopify's sort options (relevance, price, newest, etc.)
server.tool(
  "get_products_sorted",
  `Fetch up to 5 products, sorted by Shopify sort options. Supported sort keys: relevance, price_asc, price_desc, newest, best_selling.

  Parameters:
  @param {string} session_id: Session ID
  @param {string} store_code: Store name or code
  @param {string} [sort_key]: Sort key. Supported values: relevance, price_asc, price_desc, newest, best_selling, featured.
  `,
  {
    session_id: z.string().describe("Session ID"),
    store_code: z.string().describe("Store name/code"),
    sort_key: z.string().describe("Sort key for the product list"),
  },
  async ({ session_id, store_code, sort_key }) => {
    try {
      const sortArgs = getProductSortArgs(sort_key);

      const graphqlQuery = {
        query: `query getProducts($first: Int!) {
          products(first: $first${sortArgs}) {
            edges {
              node {
                id
                title
                category {
                  name
                }
                priceRange {
                  minVariantPrice {
                    amount
                    currencyCode
                  }
                }
                description
                availableForSale
              }
            }
          }
        }`,
        variables: {
          first: 5,
        },
      };

      const response = await callShopifyApi("POST", "", graphqlQuery);
      const products = response?.data?.products?.edges || [];
      const formattedProducts = formatProducts(products, session_id, store_code, false);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ products: formattedProducts }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching sorted products: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Create an Express app to handle HTTP requests
const app = express();

// Use JSON middleware to parse request bodies
app.use(express.json());

// allow origins
app.use(cors({
  origin: "*",
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));


/* 
Handle Post requests to the MCP endpoint
This is the main entry point for the MCP server
It connects the MCP server to the transport layer and processes the request
*/
app.post("/mcp", async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      console.log("Request closed");
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

// Handle GET and DELETE requests to the MCP endpoint
// These methods are not allowed, so we return a 405 Method Not Allowed response
app.get("/mcp", async (req, res) => {
  console.log("Received GET MCP request");
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    })
  );
});

app.delete("/mcp", async (req, res) => {
  console.log("Received DELETE MCP request");
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    })
  );
});

// Start the server and listen on the specified port
const PORT = process.env.PORT || 3001;
app.listen(PORT, (error) => {
  if (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
  console.log(`MCP Stateless Streamable HTTP Server listening on port ${PORT}`);
});
