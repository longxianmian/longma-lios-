import { Routes, Route, Navigate } from 'react-router-dom';

import Home from './pages/Home';
import Register from './pages/Register';
import Login from './pages/Login';

import DashboardLayout from './layouts/DashboardLayout';
import Overview from './pages/dashboard/Overview';
import Assets from './pages/dashboard/Assets';
import Plugins from './pages/dashboard/Plugins';
import Decisions from './pages/dashboard/Decisions';
import Employees from './pages/dashboard/Employees';
import ChatTest from './pages/dashboard/ChatTest';

import AdminLayout from './layouts/AdminLayout';
import AdminOverview from './pages/admin/Overview';
import AdminTenants from './pages/admin/Tenants';
import AdminKnowledge from './pages/admin/Knowledge';
import AdminMonitor from './pages/admin/Monitor';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/register" element={<Register />} />
      <Route path="/login" element={<Login />} />

      <Route path="/dashboard" element={<DashboardLayout />}>
        <Route index element={<Overview />} />
        <Route path="assets" element={<Assets />} />
        <Route path="plugins" element={<Plugins />} />
        <Route path="decisions" element={<Decisions />} />
        <Route path="employees" element={<Employees />} />
        <Route path="chat-test" element={<ChatTest />} />
      </Route>

      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<AdminOverview />} />
        <Route path="tenants" element={<AdminTenants />} />
        <Route path="knowledge" element={<AdminKnowledge />} />
        <Route path="monitor" element={<AdminMonitor />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
