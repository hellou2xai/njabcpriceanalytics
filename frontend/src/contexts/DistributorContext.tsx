import { createContext, useContext, useState, ReactNode } from 'react';

interface DistributorContextType {
  distributor: string;
  setDistributor: (d: string) => void;
}

const DistributorContext = createContext<DistributorContextType>({
  distributor: '',
  setDistributor: () => {},
});

export function DistributorProvider({ children }: { children: ReactNode }) {
  const [distributor, setDistributorState] = useState(() =>
    localStorage.getItem('lpb_distributor') ?? ''
  );

  const setDistributor = (d: string) => {
    setDistributorState(d);
    if (d) localStorage.setItem('lpb_distributor', d);
    else localStorage.removeItem('lpb_distributor');
  };

  return (
    <DistributorContext.Provider value={{ distributor, setDistributor }}>
      {children}
    </DistributorContext.Provider>
  );
}

export function useDistributor() {
  return useContext(DistributorContext);
}
