// Material catalogue for the Réfection / monthly-report material
// builder (Batch 2): moved here from MaterialBuilder.jsx so that file
// only exports components (react-refresh/only-export-components).
// Same content, no data changed.
export const MATERIAL_OPTIONS = {
  FUITE: {
    articles: {
      'Collier': { dns: ['50*20', '63*20', '75*20', '90*20', '110*20', '160*20'], unit: 'u' },
      'Raccord Manchon': { dns: ['32*32', '40*40', '50*50', '63*63'], unit: 'u' },
      'Raccord Simple': { dns: ['32*1"'], unit: 'u' },
      'R.PEC': { dns: ['25*20', '32*20', '40*40', '50*40', '63*40'], unit: 'u' },
      'Tuyau': { dns: ['21*32', '21*25', '63*21', '32*16'], unit: 'ml' }
    }
  },
  'FUITE SPECIALE': {
    articles: {
      'Manchon Reparation': { dns: ['63', '75', '90', '110'], unit: 'u' },
      'Joint Gibault': { dns: ['63', '75', '90', '110', '225', '400', '500'], unit: 'u' }
    }
  },
  RNVL: {
    mains: ['BR complete', 'Branchement sans collier', 'Branchement sans accessoires'],
    articles: {
      'Collier': { dns: ['50*20', '63*20', '75*20', '90*20', '110*20', '160*20'], unit: 'u' },
      'Tuyau': { dns: ['21*32', '21*25', '63*21', '32*16'], unit: 'ml' }
    },
    getAllowedArticles: (main) => {
      if (main === 'BR complete') return ['Collier', 'Tuyau'];
      if (main === 'Branchement sans collier') return ['Tuyau'];
      if (main === 'Branchement sans accessoires') return ['Collier', 'Tuyau'];
      return [];
    }
  }
};
