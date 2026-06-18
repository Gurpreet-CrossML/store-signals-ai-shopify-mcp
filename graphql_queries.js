// Query to search products by a free-text `search` string.
// - Variables: { search: String! }
// - Returns: up to `first: 5` matching products with selected fields,
//   including images, price range, and up to 20 variants per product.
const productSearchByQuery = `query getProducts($search: String!) {
  products(first: 5, query: $search) {
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

// GraphQL query to fetch store metadata including product tags, types, collections, and categories.
const storeMetadataQuery = `query {
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
  $sortKey: ProductSortKeys
  $reverse: Boolean
) {
  products(
    first: 5
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
        availableForSale
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

const returnableFulfillmentsQuery = `
  query GetReturnableFulfillments($orderId: ID!) {
    returnableFulfillments(orderId: $orderId, first: 10) {
      edges {
        node {
          id
          fulfillment {
            id
          }
          returnableFulfillmentLineItems(first: 10) {
            edges {
              node {
                fulfillmentLineItem {
                  id
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

// Mutation to create a return with exchange line items.
// Variables: $input: ReturnInput!
const returnCreateMutation = `
  mutation CreateReturnWithExchange($input: ReturnInput!) {
    returnCreate(returnInput: $input) {
      return {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// Mutation to process a return (finalise the exchange).
// Variables: { returnId: ID! }
const returnProcessMutation = `
  mutation ProcessReturn($returnId: ID!) {
    returnProcess(returnId: $returnId) {
      return {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;
// Export the GraphQL query for use in other modules
module.exports = {
  productSearchByQuery,
  storeMetadataQuery,
  relatedProductsQuery,
  productByIdQuery,
  productSortQuery,
  discountQuery,
  returnableFulfillmentsQuery,
  returnCreateMutation,
  returnProcessMutation,
};
