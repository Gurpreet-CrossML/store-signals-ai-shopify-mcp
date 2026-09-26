// Query to search products by a free-text `search` string, which may also
// contain field-qualified clauses (product_type:, vendor:, tag:,
// variants.price, available_for_sale:) built by buildShopifySearchQuery.
// - Variables: { search: String!, sortKey, reverse, first: Int!, after: String }
// - Returns: up to `first` matching products with selected fields, including
//   images, price range, and up to 20 variants per product, plus pageInfo
//   for callers that need to paginate (e.g. the category search tier, which
//   has no server-side category filter and must walk pages client-side).
//   The `first` value is passed dynamically from the search_products tool
//   in server.js (default: 15) — giving the calling agent's own
//   audience/budget/attribute post-filtering enough surviving candidates.
const productSearchByQuery = `query getProducts($search: String!, $sortKey: ProductSortKeys, $reverse: Boolean, $first: Int!, $after: String) {
  products(first: $first, after: $after, query: $search, sortKey:$sortKey, reverse:$reverse) {
    pageInfo {
      hasNextPage
      endCursor
    }
    edges {
      node {
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

        metafield(namespace: "custom", key: "warranty") {
          value
          type
        }

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
        }
      }
    }
  }
}`;

// Query to fetch products within a specific collection by handle. Used as a
// higher-priority search tier ahead of product_type/tags: collection.products
// supports structured `filters` (vendor/availability/price) server-side,
// unlike the top-level products search which only takes a free-text `query`.
// - Variables: { handle: String!, first: Int!, sortKey: ProductCollectionSortKeys, reverse, filters: [ProductFilter!] }
const collectionProductsQuery = `query getCollectionProducts($handle: String!, $first: Int!, $sortKey: ProductCollectionSortKeys, $reverse: Boolean, $filters: [ProductFilter!]) {
  collectionByHandle(handle: $handle) {
    products(first: $first, sortKey: $sortKey, reverse: $reverse, filters: $filters) {
      edges {
        node {
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

          metafield(namespace: "custom", key: "warranty") {
            value
            type
          }

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
          }
        }
      }
    }
  }
}`;

// GraphQL query to fetch store metadata including product tags, types, and collections.
// Categories are fetched separately via `productCategoriesQuery`, paginated,
// since they're derived from actual product data rather than a distinct-values field.
const storeMetadataQuery = `query {
  productTypes(first: 100) {
    edges {
      node
    }
  }

  collections(first: 50) {
    edges {
      node {
        title
        handle
      }
    }
  }
}`;

// Paginated query to walk the full product catalog collecting distinct
// category names - a single `products(first: 250)` call only samples the
// first page, which silently misses categories on stores with thousands of
// products. Callers page through with $after until pageInfo.hasNextPage is
// false (or a safety cap on pages is reached).
const productCategoriesQuery = `query getProductCategories($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    edges {
      node {
        category {
          name
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

// GraphQL query to fetch related products based on a given product ID.
const relatedProductsQuery = `query getRecommendations($productId: ID!) {
    productRecommendations(productId: $productId) {
        id
    }
}`;

// GraphQL query to fetch a single product by its ID, including detailed information such as images, price range, and variants.
const productByIdQuery = `query getProductById($id: ID!) {
    product(id: $id) {
        id title handle productType category { name } availableForSale onlineStoreUrl
        description descriptionHtml
        metafield(namespace: "custom", key: "warranty") {
          value
          type
        }
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
}`;

// GraphQL query to fetch products sorted by specified Shopify sort options, such as relevance, price ascending/descending, newest, or best selling.
const productSortQuery = `query getProducts(
  $search: String
  $sortKey: ProductSortKeys
  $reverse: Boolean
  $first: Int!
) {
  products(
    first: $first
    query: $search
    sortKey: $sortKey
    reverse: $reverse
  ) {
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
        metafield(namespace: "custom", key: "warranty") {
          value
          type
        }
        availableForSale
        variants(first: 20) {
          edges {
          node {
              priceV2 { amount currencyCode }
              compareAtPriceV2 { amount currencyCode }
              availableForSale
            }
          }
        }
      }
    }
  }
}`;

const discountQuery = `{
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
}`;
const getReturnableFulfillmentsQuery = `
  query GetReturnableFulfillments($orderId: ID!) {
    returnableFulfillments(orderId: $orderId, first: 10) {
      edges {
        node {
          id
          fulfillment { id }
          returnableFulfillmentLineItems(first: 10) {
            edges {
              node {
                fulfillmentLineItem {
                  id
                  lineItem { id }
                }
                quantity
              }
            }
          }
        }
      }
    }
  }
`;

const refundQuery = `
  query GetOrderRefundStatus($id: ID!) {
    order(id: $id) {
      id
      name
      displayFinancialStatus
      refundable
      refunds(first: 20) {
        id
        createdAt
      }
      transactions(first: 20) {
        id
        kind
        status
      }
    }
  }
`;

const minMaxPriceQuery = `query {
  minProduct: products(first: 1, sortKey: PRICE, reverse: false) {
    edges { node { priceRange { minVariantPrice { amount currencyCode } } } }
  }
  maxProduct: products(first: 1, sortKey: PRICE, reverse: true) {
    edges { node { priceRange { maxVariantPrice { amount currencyCode } } } }
  }
}`;

// Export the GraphQL query for use in other modules
module.exports = {
  productSearchByQuery,
  collectionProductsQuery,
  storeMetadataQuery,
  productCategoriesQuery,
  relatedProductsQuery,
  productByIdQuery,
  productSortQuery,
  discountQuery,
  refundQuery,
  getReturnableFulfillmentsQuery,
  minMaxPriceQuery,
};
