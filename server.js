const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");
const express = require("express");
const cors = require("cors");
const {
  productSearchByQuery,
  collectionProductsQuery,
  productByIdQuery,
  productSortQuery,
  discountQuery,
  refundQuery,
} = require("./graphql_queries");
const {
  MCP_NAME,
  MCP_VERSION,
  callShopifyApi,
  callBackendAPI,
  formatProducts,
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
  searchProductsByNames,
  formatRefundStatus,
  ShopifyExchangeManager,
  getExchangePolicyEligibility,
  verifyOrderIdentity,
  quoteSearchValue,
  groundTerm,
  getDynamicCleanSearchTerm,
} = require("./utils");

const { getCache, setCache } = require("./cache");

// Safety cap on how many products the category search tier will scan
// (paginated, 250 per page) per request while looking for enough category
// matches. Bounds worst-case latency on a single search_products call when
// the matched category has few/no products or the catalog is huge.
const CATEGORY_TIER_SCAN_MAX =
  Number(process.env.CATEGORY_TIER_SCAN_MAX) || 2000;

const createMcpServer = (configs = {}) => {
  const {
    baseUrl,
    storefrontAccessToken,
    adminAccessToken,
    storeCode,
    sessionId,
    widgetKey,
    customerEmail,
  } = configs;

  // fail fast if the backend forgot to send required creds
  if (
    !baseUrl ||
    !storefrontAccessToken ||
    !adminAccessToken ||
    !storeCode ||
    !sessionId ||
    !widgetKey
  ) {
    throw new Error(
      "createMcpServer: missing required config (baseUrl / storefrontAccessToken / adminAccessToken / storeCode / sessionId / widgetKey)",
    );
  }

  // Initialize the MCP server
  const server = new McpServer({
    name: MCP_NAME,
    version: MCP_VERSION,
    capabilities: {
      tools: true,
      resources: true,
    },
  });

  // ********************************** MCP Tools **********************************
  // ######### 1. Search Products #########
  server.tool(
    "search_products",
    `Search for products based on the customer's request using product, price,
    availability, tag, brand, category, collection, and sorting filters.

    Use structured filters whenever the customer's request maps to them. These filters
    are processed server-side and are more precise than putting everything into "query".

    IMPORTANT SEARCH RULES:

    1. Use "query" only for the main product/search intent.
      Examples:
      - "travel bags"
      - "laptop"
      - "running shoes"
      - "vitamin c serum"

    2. Use "collection" when the customer refers to a named store collection
      (e.g. "summer sale", "new arrivals").

    3. Use "category" when the customer's request maps to the store's standardized
      product category/taxonomy (see get_store_meta_info).

    4. Use "product_type" when the customer specifies a product type.

    5. Use "vendor" only when the customer explicitly specifies a brand/vendor.

    6. Use "tags" for store attributes such as audience, occasion, feature,
      material, skin type, concern, etc., when they correspond to store tags.

    Structured filters are searched in priority order: collection > category >
    product_type > tags > query. The server tries the highest-priority filter
    first; if that returns 2 or fewer products, it automatically searches the
    next filter in priority order and merges in any new results, cascading
    down to a free-text "query" search if needed - the customer should always
    see some relevant products rather than a near-empty result set.

    If the customer asks for a variant option that does not exist in the store
    metadata, do not invent it and do not pass it as a variant filter.
    The agent should handle unavailable variant options before calling this tool.

    Rules:
    - Translate customer intent to English for the query.
    - Keep brand names, model names, and quoted product names unchanged.
    - Never invent filters that do not exist in the store.
    - Always return every product id the tool gives you.

    Parameters:
    @param {string} query: Main free-text product search intent.
    @param {boolean} full_details: Whether to return full product details including variants, images, and URLs.
    @param {number} page_size: Number of products to return.
    @param {string} collection: Store collection name filter.
    @param {string} category: Product category/taxonomy filter.
    @param {string} product_type: Product type filter.
    @param {string} vendor: Brand/vendor filter.
    @param {string[]} tags: Store tag filters.
    @param {string} availability: "in_stock" | "out_of_stock" | "all".
    @param {number} min_price: Minimum price filter.
    @param {number} max_price: Maximum price filter.
    @param {string} sort_by: "relevance" | "price_asc" | "price_desc" | "newest" | "best_selling".`,
    {
      query: z
        .string()
        .optional()
        .default("")
        .describe(
          "Free-text search keywords (product name, description terms, or descriptive attributes not covered by product_type/tags - e.g. 'vitamin c', 'oily skin', 'wireless'). Defaults to empty string when searching by structured filters alone.",
        ),
      full_details: z
        .boolean()
        .optional()
        .describe(
          "Whether to return full product details including variants, images, and URLs. Defaults to false.",
        ),
      collection: z
        .string()
        .optional()
        .describe(
          "Store collection name, e.g. 'Summer Sale', 'New Arrivals'. Matched against the " +
            "store's real collections (see get_store_meta_info) - pass the customer's own " +
            "wording even if casing differs.",
        ),
      category: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe(
          "Standardized product category/taxonomy name(s) (see get_store_meta_info). Accepts a single category string, comma-separated categories, or an array of category strings for multi-category queries.",
        ),
      product_type: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe(
          "Product category/type name(s), e.g. ['Perfume', 'Serum']. Accepts a single type string, comma-separated types, or an array of product type strings.",
        ),
      vendor: z
        .string()
        .optional()
        .describe(
          "Brand/vendor filter, e.g. 'Chanel'. Only pass when the customer names a specific brand.",
        ),
      tags: z
        .array(z.string())
        .optional()
        .describe(
          "Attribute filters as store tags. Use for gender/audience (e.g. 'Men', 'Women', " +
            "'Unisex'), skin/hair type or concern (e.g. 'Oily Skin', 'Anti-Aging'), material, " +
            "occasion, feature, dietary preference, etc. Pass the customer's own words - they're " +
            "matched against the store's real tags, and anything with no close match automatically " +
            "falls back to free-text search instead of zeroing out the results.",
        ),
      availability: z
        .enum(["in_stock", "all"])
        .optional()
        .describe(
          "Stock filter. Defaults to showing both in-stock and out-of-stock products when omitted.",
        ),
      min_price: z.coerce
        .number()
        .nonnegative()
        .optional()
        .describe("Minimum price filter (e.g., 100 for products above $100)"),
      max_price: z.coerce
        .number()
        .nonnegative()
        .optional()
        .describe("Maximum price filter (e.g., 500 for products under $500)"),
      page_size: z
        .number()
        .optional()
        .describe("Number of products to return (default: 15)"),
      sort_by: z
        .enum([
          "relevance",
          "price_asc",
          "price_desc",
          "newest",
          "best_selling",
        ])
        .optional()
        .describe(
          'Sort order: "relevance" (default), "price_asc", "price_desc", "newest", or ' +
            '"best_selling". Use "best_selling" for "best" / "most popular" requests - no ' +
            "rating data is available, so this is the closest available signal.",
        ),
    },
    async ({
      query = "",
      full_details = false,
      page_size = 15,
      collection = null,
      category = null,
      product_type = null,
      vendor = null,
      tags = [],
      availability = "all",
      min_price = null,
      max_price = null,
      sort_by = "relevance",
    }) => {
      try {
        const { sortKey, reverse } = getProductSortConfig(sort_by);
        // collection.products uses ProductCollectionSortKeys, which spells
        // "created" differently than the top-level ProductSortKeys enum.
        const collectionSortKey =
          sortKey === "CREATED_AT" ? "CREATED" : sortKey;

        const trimmedQuery = query?.trim() || "";
        const trimmedCollection = collection?.trim() || "";
        const parseList = (val) => {
          if (Array.isArray(val))
            return val.map((s) => String(s).trim()).filter(Boolean);
          if (typeof val === "string" && val.trim()) {
            return val
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
          }
          return [];
        };

        const categoriesList = parseList(category);
        const productTypesList = parseList(product_type);
        const trimmedCategory =
          categoriesList[0] ||
          (typeof category === "string" ? category.trim() : "");
        const trimmedProductType =
          productTypesList[0] ||
          (typeof product_type === "string" ? product_type.trim() : "");

        const cleanTags = (Array.isArray(tags) ? tags : [])
          .filter(Boolean)
          .map((tag) => tag.trim())
          .filter(Boolean);
        // Non-narrowing filters that should still apply no matter which
        // priority tier ends up supplying the products.
        const broadClauses = [];
        if (vendor?.trim()) {
          broadClauses.push(`vendor:${quoteSearchValue(vendor)}`);
        }
        if (availability && availability !== "all") {
          broadClauses.push(
            `available_for_sale:${availability === "in_stock"}`,
          );
        }
        if (min_price != null && min_price >= 0) {
          broadClauses.push(`variants.price:>=${min_price}`);
        }
        if (max_price != null && max_price >= 0) {
          broadClauses.push(`variants.price:<=${max_price}`);
        }

        const collectionFilters = [];
        if (vendor?.trim()) {
          collectionFilters.push({ productVendor: vendor.trim() });
        }
        if (availability && availability !== "all") {
          collectionFilters.push({ available: availability === "in_stock" });
        }
        if (min_price != null || max_price != null) {
          const priceFilter = {};
          if (min_price != null) priceFilter.min = min_price;
          if (max_price != null) priceFilter.max = max_price;
          collectionFilters.push({ price: priceFilter });
        }

        const cacheKey = `product_search:${trimmedCollection}:${categoriesList.join(",")}:${productTypesList.join(",")}:${cleanTags.join(",")}:${trimmedQuery}:${broadClauses.join(" ")}:${sortKey}:${reverse}:${page_size}:${full_details}`;

        const cached = await getCache(cacheKey);
        if (cached) {
          logProductViewEvents(
            widgetKey,
            cached.products,
            sessionId,
            storeCode,
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(cached, null, 2),
              },
            ],
          };
        }
        const runProductSearchPage = (search, first, after = null) =>
          callShopifyApi(
            baseUrl,
            storefrontAccessToken,
            adminAccessToken,
            "POST",
            "",
            {
              query: productSearchByQuery,
              variables: { search, sortKey, reverse, first, after },
            },
          ).then((res) => res?.data?.products || {});

        const runCollectionSearch = async (handle) =>
          callShopifyApi(
            baseUrl,
            storefrontAccessToken,
            adminAccessToken,
            "POST",
            "",
            {
              query: collectionProductsQuery,
              variables: {
                handle,
                first: page_size,
                sortKey: collectionSortKey,
                reverse,
                filters: collectionFilters,
              },
            },
          ).then((res) => res?.data?.collectionByHandle?.products?.edges || []);

        let rawProducts = [];
        const seenIds = new Set();
        const mergeEdges = (edges) => {
          for (const edge of edges) {
            if (rawProducts.length >= page_size) break;
            const id = edge?.node?.id;
            if (!id || seenIds.has(id)) continue;
            seenIds.add(id);
            rawProducts.push(edge);
          }
        };

        const needsMetadata =
          trimmedCollection ||
          categoriesList.length > 0 ||
          productTypesList.length > 0;
        const metadata = needsMetadata
          ? await storeMetadata(
              baseUrl,
              storefrontAccessToken,
              adminAccessToken,
              storeCode,
            )
          : null;

        const executeSingleSearch = async (catStr, typeStr, targetLimit) => {
          let results = [];
          const localSeen = new Set();
          const mergeLocal = (edges) => {
            for (const edge of edges) {
              if (results.length >= targetLimit) break;
              const id = edge?.node?.id;
              if (!id || localSeen.has(id)) continue;
              localSeen.add(id);
              results.push(edge);
            }
          };

          // Tier 2: Category
          if (catStr && results.length <= 2) {
            const matchedCategory = groundTerm(
              catStr,
              metadata?.categories || [],
            );
            if (matchedCategory) {
              const categorySearch = broadClauses.join(" ");
              const needed = targetLimit - results.length;
              const categoryMatches = [];
              let after = null;
              let scanned = 0;

              while (
                categoryMatches.length < needed &&
                scanned < CATEGORY_TIER_SCAN_MAX
              ) {
                const products = await runProductSearchPage(
                  categorySearch,
                  250,
                  after,
                );
                const edges = products?.edges || [];

                edges.forEach((edge) => {
                  if (
                    edge?.node?.category?.name?.toLowerCase() ===
                    matchedCategory.toLowerCase()
                  ) {
                    categoryMatches.push(edge);
                  }
                });

                scanned += edges.length;

                const pageInfo = products?.pageInfo;
                if (!pageInfo?.hasNextPage || edges.length === 0) break;
                after = pageInfo.endCursor;
              }

              mergeLocal(categoryMatches);
            }
          }

          // Tier 3: product_type
          const targetType = typeStr || (results.length <= 2 ? catStr : "");
          if (targetType && results.length <= 2) {
            const matchedType =
              groundTerm(targetType, metadata?.types || []) || targetType;
            const typeSearch = [
              `product_type:${quoteSearchValue(matchedType)}`,
              ...broadClauses,
            ]
              .filter(Boolean)
              .join(" ");
            const edges = await runProductSearchPage(
              typeSearch,
              targetLimit,
            ).then((p) => p?.edges || []);
            mergeLocal(edges);
          }

          // Tier 4: tags
          if (cleanTags.length > 0 && results.length <= 2) {
            const tagClauses = cleanTags.map(
              (tag) => `tag:${quoteSearchValue(tag)}`,
            );
            const tagSearch = [...tagClauses, ...broadClauses].join(" ");
            const edges = await runProductSearchPage(
              tagSearch,
              targetLimit,
            ).then((p) => p?.edges || []);
            mergeLocal(edges);
          }

          // Tier 5: free-text query fallback
          const fallbackTerm = trimmedQuery || catStr || typeStr;
          if (fallbackTerm && results.length <= 2) {
            const metadataCandidates = [
              ...(metadata?.categories || []),
              ...(metadata?.types || []),
            ];
            const cleanSearchTerm = getDynamicCleanSearchTerm(
              fallbackTerm,
              metadataCandidates,
            );

            const querySearch = [cleanSearchTerm, ...broadClauses]
              .filter(Boolean)
              .join(" ");
            const edges = await runProductSearchPage(
              querySearch,
              targetLimit,
            ).then((p) => p?.edges || []);
            mergeLocal(edges);
          }

          return results;
        };

        if (categoriesList.length > 1) {
          const quota = Math.max(
            2,
            Math.floor(page_size / categoriesList.length),
          );
          for (const catItem of categoriesList) {
            const catEdges = await executeSingleSearch(catItem, null, quota);
            mergeEdges(catEdges);
          }
        } else if (productTypesList.length > 1) {
          const quota = Math.max(
            2,
            Math.floor(page_size / productTypesList.length),
          );
          for (const typeItem of productTypesList) {
            const typeEdges = await executeSingleSearch(null, typeItem, quota);
            mergeEdges(typeEdges);
          }
        } else {
          // Tier 1: collection
          if (trimmedCollection && rawProducts.length <= 2) {
            const matchedTitle = groundTerm(
              trimmedCollection,
              metadata?.collections || [],
            );
            const handle = matchedTitle
              ? metadata?.collectionHandles?.[matchedTitle]
              : null;
            if (handle) {
              mergeEdges(await runCollectionSearch(handle));
            }
          }

          const singleCat = categoriesList[0] || trimmedCategory;
          const singleType = productTypesList[0] || trimmedProductType;
          const edges = await executeSingleSearch(
            singleCat,
            singleType,
            page_size,
          );
          mergeEdges(edges);
        }

        if (!rawProducts || !rawProducts.length) {
          return {
            content: [
              {
                type: "text",
                text: "No products found",
              },
            ],
          };
        }

        // Format the products data to be returned
        let formattedProducts = formatProducts(
          baseUrl,
          widgetKey,
          rawProducts,
          sessionId,
          storeCode,
          full_details,
        );

        const result = {
          products: formattedProducts,
        };

        // Fetch related products for the found products to provide more comprehensive results.
        // Existing product IDs
        const existingProductIds = result.products.map((p) => String(p.id));
        const relatedProductIds = new Set();

        for (const productId of existingProductIds) {
          if (relatedProductIds.size >= 5) {
            break;
          }

          console.log("Fetching related products for ID:", productId);

          const relatedProductsData = await fetchRelatedProducts(
            productId,
            baseUrl,
            storefrontAccessToken,
            adminAccessToken,
          );

          if (!Array.isArray(relatedProductsData)) {
            continue;
          }

          for (const relatedProductId of relatedProductsData) {
            if (relatedProductIds.size >= 5) {
              break;
            }

            relatedProductIds.add(relatedProductId);
          }
        }

        result.relatedProducts = [...relatedProductIds];

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        console.log("Product searching error, Error:", error);
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
    },
  );

  // ######### 2. Fetch Products by IDs #########
  server.tool(
    "get_products_by_ids",
    `Fetch one or more products by their Shopify product IDs.
    Returns the same shape as search_products.

    Use this when you already have product IDs (e.g. from a previous search,
    a cart payload, or user-supplied links) and need full product details.

    Parameters:
    @param {string[]} product_ids  One or more numeric or GID product IDs
    `,
    {
      product_ids: z
        .array(z.string())
        .min(1)
        .describe(
          "One or more product IDs. Accepts plain numeric IDs ('123456789') " +
            "or full GIDs ('gid://shopify/Product/123456789').",
        ),
    },
    async ({ product_ids }) => {
      try {
        // Deduplicate + normalize to full GID
        const gids = [
          ...new Set(
            product_ids.map((id) =>
              id.startsWith("gid://shopify/Product/")
                ? id
                : `gid://shopify/Product/${id}`,
            ),
          ),
        ];

        // check cache first per product id
        const numericIds = gids.map((g) =>
          g.replace("gid://shopify/Product/", ""),
        );
        const cachedProducts = [];
        const toFetch = [];

        for (const id of numericIds) {
          const cached = await getCache(`product:${id}:store:${storeCode}`);
          if (cached) cachedProducts.push(cached);
          else toFetch.push(id);
        }

        const singleProductQuery = (gid) => ({
          query: productByIdQuery,
          variables: { id: gid },
        });

        // Helper to fetch a single product by GID, returning the product node or null if not found.
        const fetchOne = (gid) =>
          callShopifyApi(
            baseUrl,
            storefrontAccessToken,
            adminAccessToken,
            "POST",
            "",
            singleProductQuery(gid),
          ).then((res) => res?.data?.product ?? null);

        const CHUNK = 5;
        const fetchedResults = [];
        const missing = [];

        if (toFetch.length > 0) {
          // convert numeric IDs back to gids for fetchOne
          const fetchGids = toFetch.map((id) => `gid://shopify/Product/${id}`);
          for (let i = 0; i < fetchGids.length; i += CHUNK) {
            const chunk = fetchGids.slice(i, i + CHUNK);
            const settled = await Promise.allSettled(chunk.map(fetchOne));
            settled.forEach((s, idx) => {
              if (s.status === "fulfilled" && s.value)
                fetchedResults.push(s.value);
              else missing.push(chunk[idx]);
            });
          }
        }

        const formattedFetched = fetchedResults.length
          ? formatProducts(
              baseUrl,
              widgetKey,
              fetchedResults.map((node) => ({ node })),
              sessionId,
              storeCode,
              true,
            )
          : [];

        // cache fetched products
        for (const p of formattedFetched) {
          try {
            await setCache(`product:${p.id}:store:${storeCode}`, p);
          } catch (e) {
            console.warn("product cache set failed:", e?.message || e);
          }
        }

        const formattedProducts = [...cachedProducts, ...formattedFetched];

        if (formattedProducts.length === 0) {
          return {
            content: [
              { type: "text", text: "No products found for the provided IDs." },
            ],
          };
        }

        logProductViewEvents(
          widgetKey,
          formattedProducts,
          sessionId,
          storeCode,
        );

        const responsePayload = {
          products: formattedProducts,
          ...(missing.length > 0 && { missing_ids: missing }),
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(responsePayload, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching products by ID: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ######### 3. Fetch Sorted Products #########
  server.tool(
    "get_products_sorted",
    `Fetch up to 10 products from the store catalogue, sorted by the given key.

    Use this for pure store-level browsing when the customer has NOT named any
    product category, audience, use-case, attribute, colour, material, or budget.

    Supported sort_key values:
    - relevance (default) – general overview / "show me your products"
    - featured
    - newest
    - best_selling
    - price_asc
    - price_desc

    Optional filters:
    - min_price / max_price (numbers)

    Do not invent categories or filters that the customer did not mention.

    Parameters:
    @param {string} [sort_key]: Sort key. Supported values: relevance(default), price_asc, price_desc, newest, best_selling, featured.
    @param {number} [min_price] - Only return products priced greater than or equal to this value.
    @param {number} [max_price] - Only return products priced less than or equal to this value.
    `,
    {
      sort_key: z.string().describe("Sort key for the product list"),
      min_price: z.number().optional().describe("Minimum product price"),
      max_price: z.number().optional().describe("Maximum product price"),
    },
    async ({ sort_key, min_price, max_price }) => {
      try {
        const priceFilters = [];

        if (min_price !== undefined) {
          priceFilters.push(`variants.price:>=${min_price}`);
        }

        if (max_price !== undefined) {
          priceFilters.push(`variants.price:<=${max_price}`);
        }

        const searchQuery =
          priceFilters.length > 0 ? priceFilters.join(" AND ") : undefined;

        const cacheKey = [
          "get_products_sorted",
          sort_key || "relevance",
          min_price ?? "any",
          max_price ?? "any",
          storeCode,
        ].join(":");

        const cached = await getCache(cacheKey);
        if (cached) {
          logProductViewEvents(
            widgetKey,
            cached.products,
            sessionId,
            storeCode,
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(cached, null, 2),
              },
            ],
          };
        }

        const { sortKey, reverse } = getProductSortConfig(sort_key);

        const graphqlQuery = {
          query: productSortQuery,
          variables: {
            search: searchQuery || "",
            sortKey: sortKey,
            reverse: reverse,
            first: 10,
          },
        };

        const response = await callShopifyApi(
          baseUrl,
          storefrontAccessToken,
          adminAccessToken,
          "POST",
          "",
          graphqlQuery,
        );

        const products = response?.data?.products?.edges || [];

        const formattedProducts = formatProducts(
          baseUrl,
          widgetKey,
          products,
          sessionId,
          storeCode,
          false,
        );

        const result = { products: formattedProducts };
        try {
          await setCache(cacheKey, result);
        } catch (cacheError) {
          console.warn(
            "get_products_sorted cache set failed:",
            cacheError?.message || cacheError,
          );
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
              text: `Error fetching sorted products: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ######### 4. Fetch Store Metadata #########
  server.tool(
    "get_store_meta_info",
    `Fetch metadata about the store's product catalog.
  Returns product tags, types, collections, and categories available in the store.
  `,
    async () => {
      try {
        const { collectionHandles, ...metadata } = await storeMetadata(
          baseUrl,
          storefrontAccessToken,
          adminAccessToken,
          storeCode,
        );
        void collectionHandles;

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
    },
  );

  // ######### 5. Filter Products by Space #########
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
          images: z.any().optional(),
        }),
      ),
      space: z.object({
        width: z.number(),
        length: z.number(),
        unit: z.string().describe("cm | m | ft | inch"),
      }),
    },

    async ({ products, space }) => {
      try {
        // Parse and validate space input
        const parsedSpace = parseSpaceInput(space);

        if (!parsedSpace) {
          console.warn(
            "filter_products_by_space called with invalid space:",
            space,
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { products: products.slice(0, 5) },
                  null,
                  2,
                ),
              },
            ],
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
              (dims.length <= spaceLengthCm * 1.3 &&
                dims.width <= spaceWidthCm * 1.3) ||
              (dims.width <= spaceLengthCm * 1.3 &&
                dims.length <= spaceWidthCm * 1.3);

            if (fits) fitType = "fit";
            else if (toleranceFits) fitType = "near";
            else fitType = "oversized";
          }

          const score = getRelevanceScore(product, dims);

          scoredProducts.push({
            product,
            score,
            fitType,
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
          .map((p) => p.product);

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
    },
  );

  // ######### 6. List Available Discounts #########
  server.tool(
    "list_available_discounts",
    `List all currently active discounts, coupon codes, automatic discounts, and promotions in the store.

    Use this when the customer asks about:
    - Available coupon / promo / discount codes
    - Current offers, deals, sales, free shipping, BOGO, cashback
    - Eligibility (first-time buyer, student, etc.)
    - General questions like "any discounts?", "what offers do you have?"

    Do NOT use this when the customer wants to see discounted products or asks if a specific product is on sale.
    Returns only active offers. Never invent codes or conditions.
    `,
    {},
    async () => {
      try {
        const cacheKey = `available_discounts:store:${storeCode}`;
        const cached = await getCache(cacheKey);
        if (cached) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(cached, null, 2),
              },
            ],
          };
        }

        const graphqlQuery = {
          query: discountQuery,
        };

        const response = await callShopifyApi(
          baseUrl,
          storefrontAccessToken,
          adminAccessToken,
          "POST",
          "",
          graphqlQuery,
          true,
        );

        if (
          !response?.data?.discountNodes?.edges ||
          response?.data?.discountNodes?.edges?.length < 1
        ) {
          return {
            content: [
              {
                type: "text",
                text: "No discounts found.",
              },
            ],
          };
        }

        const discounts = formatDiscounts(response?.data?.discountNodes?.edges);

        if (discounts.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No discounts found.",
              },
            ],
          };
        }

        // Sort by end date (active first)
        discounts.sort((a, b) => new Date(b.ends_at) - new Date(a.ends_at));

        const payload = {
          total: discounts.length,
          discounts: discounts,
        };

        try {
          await setCache(cacheKey, payload);
        } catch (cacheError) {
          console.warn(
            "available_discounts cache set failed:",
            cacheError?.message || cacheError,
          );
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(payload, null, 2),
            },
          ],
        };
      } catch (error) {
        console.error("Error fetching discounts:", error);
        return {
          content: [
            {
              type: "text",
              text: `Error fetching available discounts: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ######### 9. Get Order Detail #########
  server.tool(
    "get_order_detail",
    `Fetch a specific order by order number and one identity verification field (email, phone, zip/postal code, or surname), OR fetch recent orders if no order number is provided (for logged-in users).
  Returns a single order object or an error message if verification fails.

  Parameters:
  @param {string} order_id    - Short order number (e.g. "1026"). Optional if fetching recent orders for a logged-in user.
  @param {string} email: Customer email (optional)
  @param {string} phone: Customer phone number (optional)
  @param {string} zip_code: Customer zip/postal code (optional)
  @param {string} surname: Customer surname / last name (optional)

  CRITICAL RULES FOR AI AGENTS:
  1. NEVER guess or invent ANY of the parameters above.
  2. If the user is a guest, you MUST explicitly ask the user for their email or phone number BEFORE calling this tool.
  3. If you do not have a real email, phone, zip_code, or surname provided by the user, DO NOT call this tool.
  `,
    {
      email: z
        .string()
        .trim()
        .describe("Order email (e.g. 'test@example.com')")
        .optional(),
      order_id: z
        .string()
        .trim()
        .describe(
          "Order ID (e.g. '1026'). Optional if fetching recent orders for a logged-in user.",
        )
        .optional(),
      phone: z
        .string()
        .trim()
        .describe("Phone number associated with the order")
        .optional(),
      zip_code: z
        .string()
        .trim()
        .describe("Zip or postal code associated with the order")
        .optional(),
      surname: z
        .string()
        .trim()
        .describe("Customer surname / last name associated with the order")
        .optional(),
    },
    async ({ email, order_id, phone, zip_code, surname }) => {
      try {
        let orders = [];

        // 1. Fetch from Shopify by Order ID if provided
        if (order_id) {
          const cleanOrderId = String(order_id).replace(/^#/, "").trim();
          let response = await callShopifyApi(
            baseUrl,
            storefrontAccessToken,
            adminAccessToken,
            "GET",
            `/admin/api/2024-04/orders.json?name=${encodeURIComponent(cleanOrderId)}&status=any`,
          );

          orders = response?.orders || [];

          const currentOrder = orders.find(
            (o) =>
              o?.order_number == cleanOrderId ||
              o?.name == `#${cleanOrderId}` ||
              o?.name == cleanOrderId,
          );

          if (!currentOrder) {
            return {
              content: [
                {
                  type: "text",
                  text: `We couldn’t locate order #${cleanOrderId}. Please verify the order ID and try again.`,
                },
              ],
              isError: true,
            };
          }

          // Perform guest identity verification (or use authenticated email for logged-in users)
          const verification = verifyOrderIdentity(currentOrder, {
            email: email || customerEmail,
            phone,
            zip_code,
            surname,
          });

          if (!verification.verified) {
            return {
              content: [
                {
                  type: "text",
                  text: verification.message,
                },
              ],
              isError: true,
            };
          }

          const formattedOrder = await formatOrder(currentOrder);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(formattedOrder, null, 2),
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: "Order ID is mandatory for user verification.",
              },
            ],
            isError: true,
          };
        }
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
    },
  );

  // ######### 10. Cancel Order #########
  server.tool(
    "cancel_order",
    `Cancel a Shopify order by order number.

  Parameters:
  @param {string} order_id - Order number (e.g. "1006")
  @param {string} email - Customer email
  @param {string} reason - Cancellation reason
  `,
    {
      order_id: z
        .string()
        .trim()
        .min(4, "Order ID is required")
        .describe("Order ID (e.g. '1026')"),
      email: z
        .string()
        .trim()
        .describe(
          "Order email (e.g. 'test@example.com'). Optional for logged-in users.",
        )
        .optional(),
      reason: z.string().describe("Cancellation reason"),
    },
    async ({ order_id, email, reason }) => {
      try {
        const cleanOrderId = String(order_id).replace(/^#/, "").trim();
        const response = await callShopifyApi(
          baseUrl,
          storefrontAccessToken,
          adminAccessToken,
          "GET",
          `/admin/api/2024-04/orders.json?name=${encodeURIComponent(cleanOrderId)}&status=any`,
        );

        const orders = response?.orders || [];
        if (!orders.length) {
          return {
            content: [{ type: "text", text: `Order #${order_id} not found.` }],
            isError: true,
          };
        }

        const order = orders[0];
        const formatted = await formatOrder(order);

        if (order.cancelled_at) {
          return {
            content: [{ type: "text", text: "Order already cancelled." }],
            isError: true,
          };
        }

        if (formatted.shipment_status === "delivered") {
          return {
            content: [
              {
                type: "text",
                text: "Order has already been delivered and cannot be cancelled.",
              },
            ],
            isError: true,
          };
        }

        if (formatted.shipment_status === "shipped") {
          return {
            content: [
              {
                type: "text",
                text: "Order has already been shipped and cannot be cancelled.",
              },
            ],
            isError: true,
          };
        }

        const financial = (order.financial_status || "").toLowerCase();
        if (["refunded", "voided"].includes(financial)) {
          return {
            content: [{ type: "text", text: "Order already refunded." }],
            isError: true,
          };
        }

        const cancelResponse = await callShopifyApi(
          baseUrl,
          storefrontAccessToken,
          adminAccessToken,
          "POST",
          `/admin/api/2024-04/orders/${order.id}/cancel.json`,
          { reason: reason, email: true },
        );

        if (!cancelResponse?.order) {
          return {
            content: [{ type: "text", text: "Failed to cancel the order." }],
            isError: true,
          };
        }

        const cancelled = cancelResponse.order;

        console.log(
          `cancel_order: success | order_id=${cancelled.order_number} | email=${email} | session=${sessionId} | reason=${reason}`,
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                order_id: cancelled.order_number,
                cancelled_at: cancelled.cancelled_at,
                cancel_reason: cancelled.cancel_reason,
                financial_status: cancelled.financial_status,
                message: `Order #${order_id} has been successfully cancelled.`,
              }),
            },
          ],
        };
      } catch (error) {
        console.error("cancel_order error:", error.message);
        return {
          content: [
            { type: "text", text: `Error cancelling order: ${error.message}` },
          ],
          isError: true,
        };
      }
    },
  );

  // ######### 11. Modify Order #########
  server.tool(
    "modify_order",
    `Modify an existing Shopify order using the 3-step Order Edit API
  (orderEditBegin → apply changes → orderEditCommit).

  Supported change types in the "changes" array:
    • addVariant   – add a product variant to the order
    • setQuantity  – update the quantity of an existing line item
    • remove       – remove a line item from the order

  Parameters:
  @param {string}  shopify_order_id         Shopify Order GID or plain numeric ID (e.g. "18693365366829")
  @param {array}   changes          List of change objects (see schema below)
  @param {boolean} notify_customer  Whether to send a notification email to the customer (default: false)
  @param {string}  staff_note       Internal note attached to the edit (default: "Modified via MCP Server")
  `,
    {
      shopify_order_id: z
        .string()
        .describe(
          "Shopify Order ID (long ID). Accepts plain numeric ID ('18693365366829') " +
            "or full GID ('gid://shopify/Order/18693365366829'). DO NOT PASS SHORT ORDER ID like '1012'.",
        ),
      changes: z
        .array(
          z.discriminatedUnion("type", [
            // Add a new variant
            z.object({
              type: z.literal("addVariant"),
              variantId: z
                .string()
                .describe(
                  "Variant GID or numeric ID to add, e.g. 'gid://shopify/ProductVariant/987'",
                ),
              quantity: z.number().int().positive().describe("Quantity to add"),
              locationId: z
                .string()
                .optional()
                .describe("Optional inventory location GID"),
            }),
            // Update quantity of an existing line item
            z.object({
              type: z.literal("setQuantity"),
              lineItemId: z
                .string()
                .describe(
                  "CalculatedLineItem GID, e.g. 'gid://shopify/CalculatedLineItem/456'",
                ),
              quantity: z
                .number()
                .int()
                .nonnegative()
                .describe("New quantity (0 = remove)"),
            }),
            // Remove a line item
            z.object({
              type: z.literal("remove"),
              lineItemId: z
                .string()
                .describe(
                  "CalculatedLineItem GID to remove, e.g. 'gid://shopify/CalculatedLineItem/456'",
                ),
            }),
          ]),
        )
        .min(1)
        .describe("One or more changes to apply to the order."),
      notify_customer: z
        .boolean()
        .optional()
        .describe(
          "Send a notification email to the customer after the edit. Defaults to false.",
        ),
      staff_note: z
        .string()
        .optional()
        .describe(
          "Internal staff note for the edit. Defaults to 'Modified via MCP Server'.",
        ),
    },
    async ({
      shopify_order_id,
      changes,
      notify_customer = false,
      staff_note,
    }) => {
      try {
        // Normalise to full GID
        const orderId = shopify_order_id.startsWith("gid://shopify/Order/")
          ? shopify_order_id
          : `gid://shopify/Order/${shopify_order_id}`;

        // Normalise variant / lineItem IDs inside changes
        const normalisedChanges = changes.map((c) => {
          if (c.type === "addVariant") {
            return {
              ...c,
              variantId: c.variantId.startsWith("gid://shopify/ProductVariant/")
                ? c.variantId
                : `gid://shopify/ProductVariant/${c.variantId}`,
            };
          }
          if (c.type === "setQuantity" || c.type === "remove") {
            return {
              ...c,
              lineItemId: c.lineItemId.startsWith(
                "gid://shopify/CalculatedLineItem/",
              )
                ? c.lineItemId
                : `gid://shopify/CalculatedLineItem/${c.lineItemId}`,
            };
          }
          return c;
        });

        const editor = new ShopifyOrderEditor(baseUrl, adminAccessToken);
        const result = await editor.modifyOrder(orderId, normalisedChanges, {
          notifyCustomer: notify_customer,
          staffNote: staff_note,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        console.error("modify_order error:", error);
        return {
          content: [
            {
              type: "text",
              text: `Error modifying order: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ######### 12. Order Transactions #########
  server.tool(
    "get_order_transactions",
    `Fetch payment transactions for a specific order.

  Returns a payment investigation summary that can be used
  to identify duplicate charges, authorization holds,
  refunds, captures, and other billing issues.

  Parameters:
  @param {string} email
  @param {string} order_id: Order ID / order number (e.g. "1026"). Optional if fetching recent orders for a logged-in user.
  @param {string} phone: Customer phone number (optional)
  @param {string} zip_code: Customer zip/postal code (optional)
  @param {string} surname: Customer surname / last name (optional)
  `,
    {
      order_id: z
        .string()
        .trim()
        .describe(
          "Order ID (e.g. '1026'). Optional if fetching recent orders for a logged-in user.",
        )
        .optional(),
      email: z.string().trim().optional(),
      phone: z.string().trim().optional(),
      zip_code: z.string().trim().optional(),
      surname: z.string().trim().optional(),
    },
    async ({ order_id, email, phone, zip_code, surname }) => {
      try {
        let currentOrder = null;

        // 1. Fetch from Shopify by Order ID if provided
        if (order_id) {
          const cleanOrderId = String(order_id).replace(/^#/, "").trim();
          let orderResponse = await callShopifyApi(
            baseUrl,
            storefrontAccessToken,
            adminAccessToken,
            "GET",
            `/admin/api/2024-04/orders.json?name=${encodeURIComponent(cleanOrderId)}&status=any`,
          );

          currentOrder = orderResponse?.orders?.[0];

          if (!currentOrder) {
            return {
              content: [
                {
                  type: "text",
                  text: `We couldn’t locate order #${order_id}.`,
                },
              ],
              isError: false,
            };
          }
        } else if (customerEmail) {
          let response = await callShopifyApi(
            baseUrl,
            storefrontAccessToken,
            adminAccessToken,
            "GET",
            `/admin/api/2024-04/orders.json?email=${encodeURIComponent(customerEmail)}&status=any`,
          );
          if (
            !response ||
            !Array.isArray(response.orders) ||
            response.orders.length === 0
          ) {
            return {
              content: [
                {
                  type: "text",
                  text: "We couldn’t find any orders for your account.",
                },
              ],
              isError: false,
            };
          }
          currentOrder = response.orders[0];
        } else {
          return {
            content: [
              {
                type: "text",
                text: "Order ID is mandatory for user verification.",
              },
            ],
            isError: false,
          };
        }

        const verification = verifyOrderIdentity(currentOrder, {
          email: email || customerEmail,
          phone,
          zip_code,
          surname,
        });

        if (!verification.verified) {
          return {
            content: [{ type: "text", text: verification.message }],
            isError: false,
          };
        }

        // Get transactions
        const transactionResponse = await callShopifyApi(
          baseUrl,
          storefrontAccessToken,
          adminAccessToken,
          "GET",
          `/admin/api/2024-04/orders/${currentOrder.id}/transactions.json`,
        );

        const formattedTransactions = formatOrderTransactions(
          currentOrder,
          transactionResponse?.transactions || [],
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedTransactions, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching order transactions: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ######### 13. Get Order Refund Status #########
  server.tool(
    "get_refund_status",
    `Fetch the refund status of a specific order by order number and customer email.

  Returns one of the following statuses:
    - NOT_REFUNDED       : No refunds exist on this order
    - FULLY_REFUNDED     : Order has been fully refunded
    - PARTIALLY_REFUNDED : Order has been partially refunded
    - REFUND_PENDING     : A refund is initiated but not yet settled
    - REFUND_FAILED      : A refund transaction failed

  Parameters:
  @param {string} email       - Customer email associated with the order
  @param {string} order_id    - Short order number (e.g. "1026"). Optional if fetching recent orders for a logged-in user.
  @param {string} phone: Customer phone number (optional)
  @param {string} zip_code: Customer zip/postal code (optional)
  @param {string} surname: Customer surname / last name (optional)

  CRITICAL RULES FOR AI AGENTS:
  1. NEVER guess or invent ANY of the parameters above.
  2. If the user is a guest, you MUST explicitly ask the user for their email or phone number BEFORE calling this tool.
  3. If you do not have a real email, phone, zip_code, or surname provided by the user, DO NOT call this tool.
  `,
    {
      order_id: z
        .string()
        .trim()
        .describe(
          "Order ID (e.g. '1026'). Optional if fetching recent orders for a logged-in user.",
        )
        .optional(),
      email: z.string().trim().optional(),
      phone: z.string().trim().optional(),
      zip_code: z.string().trim().optional(),
      surname: z.string().trim().optional(),
    },
    async ({ order_id, email, phone, zip_code, surname }) => {
      try {
        let restOrder = null;
        if (order_id) {
          //1. Find the order via REST (same pattern as get_order_detail)
          const cleanOrderId = String(order_id).replace(/^#/, "").trim();
          let ordersResponse = await callShopifyApi(
            baseUrl,
            storefrontAccessToken,
            adminAccessToken,
            "GET",
            `/admin/api/2024-04/orders.json?name=${encodeURIComponent(cleanOrderId)}&status=any`,
          );

          restOrder = ordersResponse?.orders?.[0];

          if (!restOrder) {
            return {
              content: [
                {
                  type: "text",
                  text: `We couldn't locate order #${order_id}. Please verify the order number and try again.`,
                },
              ],
              isError: false,
            };
          }
        } else if (customerEmail) {
          let response = await callShopifyApi(
            baseUrl,
            storefrontAccessToken,
            adminAccessToken,
            "GET",
            `/admin/api/2024-04/orders.json?email=${encodeURIComponent(customerEmail)}&status=any`,
          );
          if (
            !response ||
            !Array.isArray(response.orders) ||
            response.orders.length === 0
          ) {
            return {
              content: [
                {
                  type: "text",
                  text: "We couldn’t find any orders for your account.",
                },
              ],
              isError: false,
            };
          }
          restOrder = response.orders[0];
        } else {
          return {
            content: [
              {
                type: "text",
                text: "Order ID is mandatory for user verification.",
              },
            ],
            isError: false,
          };
        }

        const verification = verifyOrderIdentity(restOrder, {
          email: email || customerEmail,
          phone,
          zip_code,
          surname,
        });

        if (!verification.verified) {
          return {
            content: [{ type: "text", text: verification.message }],
            isError: false,
          };
        }

        const shopifyOrderGid = `gid://shopify/Order/${restOrder.id}`;

        const graphqlResponse = await callShopifyApi(
          baseUrl,
          storefrontAccessToken,
          adminAccessToken,
          "POST",
          "",
          { query: refundQuery, variables: { id: shopifyOrderGid } },
          true, // isAdmin = true → uses /admin/api/2025-10/graphql.json
        );

        const gqlOrder = graphqlResponse?.data?.order;

        if (!gqlOrder) {
          return {
            content: [
              {
                type: "text",
                text: `Unable to retrieve refund details for order #${order_id}. Please try again later.`,
              },
            ],
            isError: true,
          };
        }

        // 4. Format and return
        const payload = formatRefundStatus(restOrder, gqlOrder);

        console.log(
          `get_refund_status: order_id=${order_id} | status=${payload.refund_status} | session=${sessionId}`,
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(payload, null, 2),
            },
          ],
        };
      } catch (error) {
        console.error("get_refund_status error:", error.message);
        return {
          content: [
            {
              type: "text",
              text: `Error fetching refund status: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ######### 14. Search Products by Names (batch, one-by-one, Muti Product Search) #########
  server.tool(
    "search_products_by_names",
    `Search for multiple products one by one using an array of product names.
  Each name is searched independently against the Shopify catalog and the results
  are returned as an ordered array that mirrors the input list.

  Use this when the user provides a list of specific product names they want to look up,
  for example: ["Product 1", "Product 2", "Product 3"].

  Each entry in the response includes:
  - query: the original product name searched
  - found: whether any matching products were discovered
  - products: array of matched product objects (same shape as search_products)

  Parameters:
  @param {string[]} product_names: Array of product names to search for
  @param {boolean}  full_details:  Whether to return full product details including variants, images, and URLs. Defaults to false.
  `,
    {
      product_names: z
        .array(z.string().min(1))
        .min(1)
        .describe(
          "Array of product names to search for, e.g. ['Product 1', 'Product 2'].",
        ),
      full_details: z
        .boolean()
        .optional()
        .describe(
          "Whether to return full product details including variants, images, and URLs. Defaults to false.",
        ),
    },
    async ({ product_names, full_details = false }) => {
      try {
        const results = await searchProductsByNames(
          baseUrl,
          storefrontAccessToken,
          adminAccessToken,
          storeCode,
          widgetKey,
          product_names,
          sessionId,
          full_details,
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error searching products by names: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ######### 15. Exchange Items #########
  server.tool(
    "exchange_items",
    `Exchange products on a fulfilled order using Shopify's Exchange API.

  IMPORTANT: Before processing the exchange this tool automatically checks the
  store's return/exchange policy (fetched live from the Storefront API and
  parsed with AI). If the order is outside the exchange window, or the item is
  marked non-exchangeable (e.g. hygiene / Final-Sale products), the exchange
  will be declined with a clear reason — no Shopify API call is made.

  Parameters:
  @param {string}  order_id              Shopify Order ID (numeric or GID)
                                         (e.g. "2026-06-22T02:52:51-04:00")
  @param {array}   return_items          List of items being returned:
      [ { fulfillment_line_item_id, quantity, returnReason? }, ... ]
  @param {array}   exchange_items        List of new items to add:
      [ { variant_id, quantity }, ... ]
  @param {string[]} [product_tags]       Tags from the order line item (optional).
                                         Used to detect non-returnable products
                                         (e.g. ["serum", "final-sale"]).
  @param {string}  [staff_note]          Internal note (default: "Exchange via MCP")
  `,
    {
      order_id: z
        .string()
        .describe(
          "Shopify Order ID (numeric or full GID). Example: '123456789' or 'gid://shopify/Order/123456789'",
        ),
      fulfillment_created_at: z
        .string()
        .describe(
          "ISO-8601 created_at timestamp from fulfillments[0].created_at in the order response " +
            "(e.g. '2026-06-22T02:53:43-04:00'). This is the date the order was actually " +
            "shipped/fulfilled — the exchange window is calculated from this date, NOT from order.created_at.",
        ),
      return_items: z
        .array(
          z.object({
            fulfillment_line_item_id: z
              .union([z.string(), z.number()])
              .transform((val) => String(val))
              .describe(
                "FulfillmentLineItem GID returned by get_fulfillment_line_item_id, " +
                  "e.g. 'gid://shopify/FulfillmentLineItem/456'",
              ),
            quantity: z
              .number()
              .int()
              .positive()
              .describe("Quantity being returned"),
            returnReason: z
              .enum([
                "SIZE_TOO_SMALL",
                "SIZE_TOO_LARGE",
                "COLOR",
                "STYLE",
                "WRONG_ITEM",
                "UNWANTED",
                "DEFECTIVE",
                "NOT_AS_DESCRIBED",
                "OTHER",
                "UNKNOWN",
              ])
              .describe(
                "Shopify return reason. Defaults to 'UNKNOWN' if omitted. " +
                  "Use SIZE_TOO_SMALL / SIZE_TOO_LARGE for size issues, COLOR for wrong color, " +
                  "STYLE for wrong variant, WRONG_ITEM for wrong product, UNWANTED for change of mind.",
              ),
          }),
        )
        .min(1)
        .describe("One or more line items to return."),
      exchange_items: z
        .array(
          z.object({
            variant_id: z
              .union([z.string(), z.number()])
              .transform((val) => String(val))
              .describe(
                "Product variant GID to add, e.g. 'gid://shopify/ProductVariant/987'",
              ),
            quantity: z
              .number()
              .int()
              .positive()
              .describe("Quantity to exchange"),
          }),
        )
        .min(1)
        .describe("One or more new variants to add to the order."),
      product_type: z
        .string()
        .describe(
          "productType of the item being exchanged (e.g. 'Laptop Bags'). " +
            "Used to detect consumable/non-returnable product types. Pass empty string if unknown.",
        ),
      staff_note: z
        .string()
        .optional()
        .describe("Internal staff note. Defaults to 'Exchange via MCP'."),
    },
    async ({
      order_id,
      fulfillment_created_at,
      return_items,
      exchange_items,
      product_type,
    }) => {
      try {
        // ── Guard: detect order NUMBER passed instead of shopify ORDER ID ────────
        // shopify_order_id is always a large number (> 1,000,000,000).
        // A small number like 1074 is the human-readable order_number — it won't
        // resolve to a valid Shopify GID and will cause "no returnable fulfillments".
        const numericOrderId = parseInt(
          String(order_id).replace(/\D/g, ""),
          10,
        );
        if (!isNaN(numericOrderId) && numericOrderId < 1_000_000) {
          const errMsg =
            `order_id "${order_id}" looks like an order number, not a Shopify order ID. ` +
            `Use the "shopify_order_id" field from get_order_detail (a large number like 7116424446018), ` +
            `not the "order_number" field (e.g. 1074).`;
          console.error("[exchange_items] ✗ WRONG order_id —", errMsg);
          return {
            content: [
              { type: "text", text: JSON.stringify({ error: errMsg }) },
            ],
            isError: true,
          };
        }

        // ── Guard: warn if fulfillment_created_at is missing ────────────────────
        if (!fulfillment_created_at) {
          console.warn(
            "[exchange_items] ⚠ fulfillment_created_at is missing. " +
              "Pass the 'fulfillment_created_at' field from get_order_detail. " +
              "Policy window check will be skipped (fail-open).",
          );
        }

        // ── Step 1: policy eligibility check ────────────────────────────────────
        const policyCheck = await getExchangePolicyEligibility(
          baseUrl,
          storefrontAccessToken,
          adminAccessToken,
          storeCode,
          fulfillment_created_at,
          product_type,
        );

        if (!policyCheck.eligible) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    eligible: false,
                    reason: policyCheck.reason,
                    days_allowed: policyCheck.days_allowed,
                    days_since_order: policyCheck.days_since_order,
                    suggestion:
                      "Please contact our support team if you believe this is an error.",
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }

        // ── Step 2: normalise IDs and process exchange ───────────────────────
        // Normalise IDs inside the arrays (accept both GID and numeric)
        const normaliseGid = (id, type) => {
          const prefix = `gid://shopify/${type}/`;
          return id.startsWith(prefix) ? id : `${prefix}${id}`;
        };

        const normalisedReturnItems = return_items.map((item) => ({
          fulfillmentLineItemId: normaliseGid(
            item.fulfillment_line_item_id,
            "FulfillmentLineItem",
          ),
          quantity: item.quantity,
          returnReason: item.returnReason || "UNKNOWN",
        }));

        const normalisedExchangeItems = exchange_items.map((item) => ({
          variantId: normaliseGid(item.variant_id, "ProductVariant"),
          quantity: item.quantity,
        }));

        const exchangeManager = new ShopifyExchangeManager(
          baseUrl,
          adminAccessToken,
        );
        const result = await exchangeManager.exchangeItems(
          order_id,
          normalisedReturnItems,
          normalisedExchangeItems,
        );

        // Optionally log the event if sessionId provided
        if (sessionId) {
          await callBackendAPI(widgetKey, "POST", "/chat/bot-events/", {
            thread_id: sessionId,
            event_type: "exchange_items",
            order_id: order_id,
            return_items: JSON.stringify(return_items),
            exchange_items: JSON.stringify(exchange_items),
          }).catch(() => {});
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
        console.error("exchange_items error:", error);
        return {
          content: [
            {
              type: "text",
              text: `Error performing exchange: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ######### 16. Check Exchange Policy Eligibility #########
  server.tool(
    "check_exchange_eligibility",
    `Check if an order item is eligible for exchange based on the store's return/exchange policy.

  Checks two things:
  1. Exchange window  — is the item within the allowed exchange window (e.g. 7 days from fulfillment)?
  2. Product type     — is the productType eligible for exchange (not a consumable / non-returnable)?

  When to call:
  - Right after get_order_detail (pass fulfillment_created_at, leave product_type = ""):
      → detects an expired exchange window BEFORE searching for a replacement.
  - Right after search_products (pass fulfillment_created_at + productType from the search result):
      → confirms both window eligibility AND product-type eligibility.

  Returns: { eligible, days_allowed, days_since_fulfillment, days_remaining, reason }
  If eligible is false, surface the reason to the customer and DO NOT proceed with exchange_items.
  `,
    {
      fulfillment_created_at: z
        .string()
        .describe(
          "ISO-8601 created_at from fulfillments[0].created_at in the order response " +
            "(e.g. '2026-06-22T02:53:43-04:00'). The exchange window is measured from this date.",
        ),
      product_type: z
        .string()
        .describe(
          "productType of the item being exchanged (e.g. 'Laptop Bags'). " +
            "Pass empty string '' when only checking the time window (product type not yet known).",
        ),
    },
    async ({ fulfillment_created_at, product_type = "" }) => {
      try {
        const result = await getExchangePolicyEligibility(
          baseUrl,
          storefrontAccessToken,
          adminAccessToken,
          storeCode,
          fulfillment_created_at,
          product_type,
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        console.error("[check_exchange_eligibility] Error:", error.message);
        // Fail open — let exchange_items perform its own check
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  eligible: true,
                  reason:
                    "Policy check could not be completed — proceeding with exchange",
                  error: error.message,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // ######### 17. Fetch Discounted Products #########
  server.tool(
    "get_discounted_products",
    `Fetch up to 10 products that are currently on discount / sale.

    Use this when the customer:
    - Asks to see sale items / discounted products
    - Mentions a product name + sale/discount language ("is X on sale?", "discount on Y")
    - Wants products sorted by price, newest, best-selling, etc. among discounted items

    Optional: query (search text), min_price, max_price.

    Parameters:
    @param {string} query: Search query for discounted products
    @param {string} [sort_key]: Sort key. Supported values: relevance(default), price_asc, price_desc, newest, best_selling, featured.
    @param {number} [min_price] - Only return products priced greater than or equal to this value.
    @param {number} [max_price] - Only return products priced less than or equal to this value.
    `,
    {
      query: z
        .string()
        .optional()
        .describe("Search query for discounted products"),
      sort_key: z.string().optional().describe("Sort key for the product list"),
      min_price: z.number().optional().describe("Minimum product price"),
      max_price: z.number().optional().describe("Maximum product price"),
    },
    async ({ query, sort_key, min_price, max_price }) => {
      try {
        const priceFilters = [];

        if (min_price !== undefined) {
          priceFilters.push(`variants.price:>=${min_price}`);
        }

        if (max_price !== undefined) {
          priceFilters.push(`variants.price:<=${max_price}`);
        }

        const searchFilters = [];

        if (query?.trim()) {
          searchFilters.push(query.trim());
        }

        searchFilters.push(...priceFilters);

        const searchQuery =
          searchFilters.length > 0 ? searchFilters.join(" AND ") : undefined;

        const cacheKey = [
          "get_discounted_products",
          sort_key || "relevance",
          min_price ?? "any",
          max_price ?? "any",
          query ?? "",
          storeCode,
        ].join(":");

        const cached = await getCache(cacheKey);
        if (cached) {
          logProductViewEvents(
            widgetKey,
            cached.products,
            sessionId,
            storeCode,
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(cached, null, 2),
              },
            ],
          };
        }

        const { sortKey, reverse } = getProductSortConfig(sort_key);

        const graphqlQuery = {
          query: productSortQuery,
          variables: {
            search: searchQuery,
            sortKey: sortKey,
            reverse: reverse,
            first: 20,
          },
        };

        const response = await callShopifyApi(
          baseUrl,
          storefrontAccessToken,
          adminAccessToken,
          "POST",
          "",
          graphqlQuery,
        );

        const products = response?.data?.products?.edges || [];

        const formattedProducts = formatProducts(
          baseUrl,
          widgetKey,
          products,
          sessionId,
          storeCode,
          false,
          true,
        );

        const result = { products: formattedProducts };
        try {
          await setCache(cacheKey, result);
        } catch (cacheError) {
          console.warn(
            "get_discounted_products cache set failed:",
            cacheError?.message || cacheError,
          );
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
              text: `Error fetching discounted products: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ######### 18. Get Latest Order #########
  server.tool(
    "get_latest_order",
    `Fetch the most recent order for the currently logged-in user.
    Takes no parameters. This tool will automatically use the authenticated user's email.
    Use this ONLY when the customer is logged in and asks for their recent order.`,
    {},
    async () => {
      try {
        if (!customerEmail) {
          return {
            content: [
              {
                type: "text",
                text: "No logged-in user email found. Cannot fetch latest order for guest users.",
              },
            ],
            isError: true,
          };
        }

        const response = await callShopifyApi(
          baseUrl,
          storefrontAccessToken,
          adminAccessToken,
          "GET",
          `/admin/api/2024-04/orders.json?email=${encodeURIComponent(customerEmail)}&status=any`,
        );

        if (
          !response ||
          !Array.isArray(response.orders) ||
          response.orders.length === 0
        ) {
          return {
            content: [
              {
                type: "text",
                text: "We couldn’t find any orders for your account.",
              },
            ],
            isError: false,
          };
        }

        const latestOrder = response.orders[0];
        const formattedOrder = await formatOrder(latestOrder);

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
              text: `Error fetching latest order: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ********************************** End of MCP Tools **********************************

  return server;
}; // end createMcpServer

// Start the server
const app = express();
app.use(express.json());

// Enable CORS for all routes and origins to allow cross-origin requests from any client, which is essential for the MCP server to be accessible from different domains and frontend applications without CORS issues.
app.use(
  cors({
    origin: "*",
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  }),
);

// Handle incoming MCP requests at the /mcp endpoint.
// A fresh McpServer is created per request so concurrent stateless
// HTTP sessions each own their transport without conflict.
app.post("/mcp", async (req, res) => {
  try {
    const configs = {
      baseUrl: req.headers["x-base-url"],
      storefrontAccessToken: req.headers["x-storefront-access-token"],
      adminAccessToken: req.headers["x-admin-access-token"],
      storeCode: req.headers["x-store-code"],
      sessionId: req.headers["x-session-id"],
      widgetKey: req.headers["x-widget-key"],
      customerEmail: req.headers["x-customer-email"],
    };

    const server = createMcpServer(configs);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
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

// Explicitly disallow GET and DELETE methods on the /mcp endpoint to ensure that only POST requests are accepted, which is important for maintaining the integrity of the MCP server's JSON-RPC communication and preventing unintended access or operations through unsupported HTTP methods.
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
    }),
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
    }),
  );
});

// Start the Express server on the specified port, and log a message indicating that the MCP Stateless Streamable HTTP Server is listening. If there is an error during startup, it will be logged and the process will exit with a failure code.
const PORT = process.env.PORT || 3000;
app.listen(PORT, (error) => {
  if (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
  console.log(`MCP Stateless Streamable HTTP Server listening on port ${PORT}`);
});
