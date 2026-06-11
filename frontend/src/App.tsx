import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { stores as storesApi } from './lib/api';
import { ProductQuickViewProvider } from './components/ProductQuickView';
import { ContextMenuProvider } from './components/ContextMenu';
import { WebPriceSearchProvider } from './components/WebPriceSearch';
import { DistributorProvider } from './contexts/DistributorContext';
import { OrderAnalysisProvider } from './contexts/OrderAnalysisContext';
import { ResultCountProvider } from './lib/resultCount';
import { DialogProvider } from './components/Dialog';
import { ToastProvider } from './components/Toast';
import ErrorBoundary from './components/ErrorBoundary';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import FeedbackWidget, { BetaBadge } from './components/FeedbackWidget';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Home from './pages/Home';
import Catalog from './pages/Catalog';
import Products from './pages/Products';
import WhatsNew from './pages/WhatsNew';
import ProductDetail from './pages/ProductDetail';
import CelarAssistant from './pages/CelarAssistant';
import NewItems from './pages/NewItems';
import HowToGuide from './pages/HowToGuide';
import Tours from './pages/Tours';
import TimeSensitive from './pages/TimeSensitive';
import PriceMovers from './pages/PriceMovers';
import MajorDiscounts from './pages/MajorDiscounts';
import Todo from './pages/Todo';
import Discounts from './pages/Discounts';
import ComparePrices from './pages/ComparePrices';
import CompareRips from './pages/CompareRips';
import Price360 from './pages/Price360';
import EditionCompare from './pages/EditionCompare';
import RateShop from './pages/RateShop';
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
import AdminAiFeedback from './pages/AdminAiFeedback';
import AdminCloseoutFlags from './pages/AdminCloseoutFlags';
import AdminCelrProducts from './pages/AdminCelrProducts';
import AgentProposals from './pages/AgentProposals';
import AgentStoreFeed from './pages/AgentStoreFeed';
import AgentSettings from './pages/AgentSettings';
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
    // refetchOnWindowFocus: when you return to a long-lived tab after a deploy,
    // queries re-fetch so the data can't sit stale (the recurring "it's not
    // showing" was a tab serving cached results from before a backend change).
    queries: { staleTime: 60_000, retry: 1, refetchOnWindowFocus: true },
  },
});

// Admin-only routes: a non-admin who deep-links here lands on Home. The nav
// already hides these items (adminOnly flags in Layout.tsx); this closes the
// type-the-URL path.
function AdminRoute({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (!user?.is_admin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

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
    <DialogProvider>
      <BetaBadge inApp />
      <FeedbackWidget />
      <StoreGate>
      <OrderAnalysisProvider>
      <ProductQuickViewProvider>
      <ResultCountProvider>
      <BrowserRouter>
        <WebPriceSearchProvider>
        <ContextMenuProvider>
        <ErrorBoundary>
        <Routes>
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route element={<Layout />}>
            <Route path="/" element={<Home />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/catalog" element={<AdminRoute><Catalog /></AdminRoute>} />
            <Route path="/products" element={<Products />} />
            <Route path="/whats-new" element={<WhatsNew />} />
            <Route path="/product" element={<ProductDetail />} />
            <Route path="/assistant" element={<CelarAssistant />} />
            <Route path="/new-items" element={<NewItems />} />
            <Route path="/how-to-guide" element={<HowToGuide />} />
            <Route path="/tours" element={<Tours />} />
            <Route path="/time-sensitive" element={<TimeSensitive />} />
            <Route path="/price-drops" element={<PriceMovers direction="down" />} />
            <Route path="/price-increases" element={<PriceMovers direction="up" />} />
            <Route path="/major-discounts" element={<MajorDiscounts />} />
            <Route path="/discounts" element={<Discounts />} />
            <Route path="/compare-prices" element={<ComparePrices />} />
            <Route path="/compare-rips" element={<CompareRips />} />
            <Route path="/price-360" element={<AdminRoute><Price360 /></AdminRoute>} />
            <Route path="/edition-compare" element={<EditionCompare />} />
            <Route path="/rate-shop" element={<AdminRoute><RateShop /></AdminRoute>} />
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
            <Route path="/agents/proposals" element={<AgentProposals />} />
            <Route path="/agents/store-feed" element={<AgentStoreFeed />} />
            <Route path="/agents/settings" element={<AgentSettings />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/admin/activity" element={<AdminActivity />} />
            <Route path="/admin/ai-usage" element={<AdminAiUsage />} />
            <Route path="/admin/ai-feedback" element={<AdminAiFeedback />} />
            <Route path="/admin/closeout-flags" element={<AdminCloseoutFlags />} />
            <Route path="/admin/celr-products" element={<AdminRoute><AdminCelrProducts /></AdminRoute>} />
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
        </ErrorBoundary>
        </ContextMenuProvider>
        </WebPriceSearchProvider>
      </BrowserRouter>
      </ResultCountProvider>
      </ProductQuickViewProvider>
      </OrderAnalysisProvider>
      </StoreGate>
    </DialogProvider>
    </QueryClientProvider>
    </DistributorProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <ErrorBoundary>
          <AuthenticatedApp />
        </ErrorBoundary>
        <CookieConsent />
      </ToastProvider>
    </AuthProvider>
  );
}
