import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { stores as storesApi } from './lib/api';
import { ProductQuickViewProvider } from './components/ProductQuickView';
import { ContextMenuProvider } from './components/ContextMenu';
import { WebPriceSearchProvider } from './components/WebPriceSearch';
import { DistributorProvider } from './contexts/DistributorContext';
import { OrderAnalysisProvider } from './contexts/OrderAnalysisContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import FeedbackWidget, { BetaBadge } from './components/FeedbackWidget';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Catalog from './pages/Catalog';
import CatalogFontTest from './pages/CatalogFontTest';
import CelarAssistant from './pages/CelarAssistant';
import NewItems from './pages/NewItems';
import HowToGuide from './pages/HowToGuide';
import Tours from './pages/Tours';
import TimeSensitive from './pages/TimeSensitive';
import PriceMovers from './pages/PriceMovers';
import MajorDiscounts from './pages/MajorDiscounts';
import Todo from './pages/Todo';
import Discounts from './pages/Discounts';
import Clearance from './pages/Clearance';
import Combos from './pages/Combos';
import Rips from './pages/Rips';
import RipProducts from './pages/RipProducts';
import Analytics from './pages/Analytics';
import Decisions from './pages/Decisions';
import Watchlist from './pages/Watchlist';
import Notes from './pages/Notes';
import Orders from './pages/Orders';
import OrderDetail from './pages/OrderDetail';
import Alerts from './pages/Alerts';
import SalesReps from './pages/SalesReps';
import Stores from './pages/Stores';
import Profile from './pages/Profile';
import Onboarding from './pages/Onboarding';
import Configuration from './pages/Configuration';
import Admin from './pages/Admin';
import AdminActivity from './pages/AdminActivity';
import AdminAiUsage from './pages/AdminAiUsage';
import QA from './pages/QA';
import OrderAnalysis from './pages/OrderAnalysis';
import Cart from './pages/Cart';
import Lists from './pages/Lists';
import AdditionalPages from './pages/AdditionalPages';
import Login from './pages/Login';
import Landing from './pages/Landing';
import { Terms, Privacy } from './pages/Legal';
import CookieConsent from './components/CookieConsent';
import Activate from './pages/Activate';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, retry: 1 },
  },
});

// Gate: a signed-in user must have at least one store before reaching the app.
function StoreGate({ children }: { children: ReactNode }) {
  const { data: stores, isLoading } = useQuery({ queryKey: ['stores'], queryFn: storesApi.list });
  if (isLoading) return <div className="app-loading">Loading your workspace...</div>;
  if (!stores || stores.length === 0) return <Onboarding />;
  return <>{children}</>;
}

function AuthenticatedApp() {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    // Public routes so emailed links (activation, password reset) work before
    // the user is signed in. Everything else falls through to the login screen.
    return (
      <BrowserRouter>
        <BetaBadge />
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/activate" element={<Activate />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="*" element={<Login />} />
        </Routes>
      </BrowserRouter>
    );
  }

  return (
    <DistributorProvider>
    <QueryClientProvider client={queryClient}>
      <BetaBadge inApp />
      <FeedbackWidget />
      <StoreGate>
      <OrderAnalysisProvider>
      <ProductQuickViewProvider>
      <BrowserRouter>
        <WebPriceSearchProvider>
        <ContextMenuProvider>
        <Routes>
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/catalog" element={<Catalog />} />
            <Route path="/admin/catalog-font-test" element={<CatalogFontTest />} />
            <Route path="/assistant" element={<CelarAssistant />} />
            <Route path="/new-items" element={<NewItems />} />
            <Route path="/how-to-guide" element={<HowToGuide />} />
            <Route path="/tours" element={<Tours />} />
            <Route path="/time-sensitive" element={<TimeSensitive />} />
            <Route path="/price-drops" element={<PriceMovers direction="down" />} />
            <Route path="/price-increases" element={<PriceMovers direction="up" />} />
            <Route path="/major-discounts" element={<MajorDiscounts />} />
            <Route path="/discounts" element={<Discounts />} />
            <Route path="/clearance" element={<Clearance />} />
            <Route path="/combos" element={<Combos />} />
            <Route path="/rips" element={<Rips />} />
            <Route path="/rip-products" element={<RipProducts />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/decisions" element={<Decisions />} />
            <Route path="/watchlist" element={<Watchlist />} />
            <Route path="/notes" element={<Notes />} />
            <Route path="/todo" element={<Todo />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/orders/:id" element={<OrderDetail />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/sales-reps" element={<SalesReps />} />
            <Route path="/stores" element={<Stores />} />
            <Route path="/configuration" element={<Configuration />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/admin/activity" element={<AdminActivity />} />
            <Route path="/admin/ai-usage" element={<AdminAiUsage />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/qa" element={<QA />} />
            <Route path="/cart" element={<Cart />} />
            <Route path="/lists" element={<Lists />} />
            <Route path="/order-analysis" element={<OrderAnalysis />} />
            <Route path="/more" element={<AdditionalPages />} />
            {/* After login the URL may be /login (or another public path); send
                any unmatched authenticated route back to the dashboard. */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        </ContextMenuProvider>
        </WebPriceSearchProvider>
      </BrowserRouter>
      </ProductQuickViewProvider>
      </OrderAnalysisProvider>
      </StoreGate>
    </QueryClientProvider>
    </DistributorProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AuthenticatedApp />
      <CookieConsent />
    </AuthProvider>
  );
}
