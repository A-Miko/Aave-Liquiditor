const queries = {
  'arbitrum': 
    `query ($lastId: String!) {
        positions(
            first: 1000, 
            orderBy: id, 
            orderDirection: asc,
            where: { 
                id_gt: $lastId, 
                side: BORROWER, 
                principal_gt: "10000000" 
            }
        ) {
            id
            account { id }
            principal
        }
    }`,
    'base': `
    `,
};

export default queries;