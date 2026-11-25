import React, { useState, useEffect } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import Sidebar from "../Dashboardsidebaarmenu/Dashboardmenu";
import Header from "../SuperAdmin/header.js";
import Footer from "../SuperAdmin/footer.js";

// 🧩 All your shared modules
import Dashboard from "../SuperAdmin/Dashboard.js";
import GetUsers from "../Modules/Users/List";
import AddUser from "../Modules/Users/Add";
import EditUser from "../Modules/Users/Edit";
import Employees from "../Modules/Users/Employees/List";
import Roles from "../Modules/Users/Roles/List";
import PermissionsTable from "../Modules/Users/Permissions/permission";
import Attendance from "../Modules/Users/Attendance/List";
import Contractors from "../Modules/Users/Contractors/List";
import Rfid from "../Modules/Users/Rfid/List";
import Device from "../Modules/Users/Device/List";
import Zones from "../Modules/Users/Zones/List";
import Visitors from "../Modules/Users/Visitors/List";
import AddVisitor from "../Modules/Users/Visitors/Add";
import EditVisitor from "../Modules/Users/Visitors/Edit";
import UserOverview from "../Modules/Users/UserOverview.js";
import ActivityPgae from "../Modules/Users/ActivityPgae.js";
import Fields from "../Modules/Settings/Fields/Fieldlist";
import LocationList from "../Modules/Employee/Location/List.js";
import LocationAdd from "../Modules/Employee/Location/Add.js";
import LocationEdit from "../Modules/Employee/Location/Edit.js";
import Settings from "../Modules/Users/Settings.js";
import NotificationsPage from "../Modules/Notifications/NotificationsPage.js";
import EnquiriesPage from "../Modules/Enquiries/EnquiriesPage";
import WarningsPage from "../Modules/Warnings/WarningsPage";
import PolicyPackagesList from "../Modules/SuperAdminDashboard/PolicyPackages/List";
import EventsList from "../Modules/SuperAdminDashboard/Events/List";
import { can, normalizeRole } from "../Helpers/acl.js";
import PlantOpsAccess from "../Modules/PlantOps/Access";
import ClientRegistry from "../Modules/Vendors/Registry";



function DashboardLayout({ userRole }) {
  const location = useLocation();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const roleKey = normalizeRole(userRole);
  const canReadAttendance = can(roleKey, "attendance", "read");
  const canReadLocation = can(roleKey, "location", "read");
  const canCreateLocation = can(roleKey, "location", "create");
  const canUpdateLocation = can(roleKey, "location", "update");

  useEffect(() => {
    console.log("📍 Current path:", location.pathname);
  }, [location.pathname]);

  // ✅ Universal responsive layout styling
  return (
    <div className="AJ-dashboard min-h-screen flex">
      {/* Sidebar */}
      <Sidebar
        isCollapsed={isCollapsed}
        setIsCollapsed={setIsCollapsed}
        userRole={userRole}
      />

      {/* Right Section */}
      <div
        className={`flex flex-col flex-1 min-w-0 transition-all duration-300 right-section-all-pages ${
          isCollapsed ? "sidebar-is-collapsed" : "sidebar-is-expanded"
        }`}
      >
        <Header />

        <main className="flex-1 min-w-0">
          <div className="p-4 sm:p-6 min-h-[calc(100vh-110px)]">
            <Routes>
              {/* ✅ Dashboard */}
              <Route index element={<Dashboard />} />
              {roleKey === "superadmin" && <Route path="plant-ops" element={<PlantOpsAccess />} />}
              {roleKey === "superadmin" && <Route path="clients" element={<ClientRegistry />} />}

              {/* ✅ Users */}
              <Route path="users" element={<GetUsers />} />
              <Route path="users/add" element={<AddUser />} />
              <Route path="users/edit/:id" element={<EditUser />} />

              {/* ✅ Employees, Roles, Permissions */}
              <Route path="users/employees" element={<Employees />} />
              <Route path="users/visitors" element={<Visitors />} />
              <Route path="users/user/:employeeId" element={<UserOverview />} />
              <Route path="users/employees/user/:employeeId" element={<UserOverview />} />
              <Route path="users/visitors/user/:employeeId" element={<UserOverview />} />
              <Route path="users/visitors/add" element={<AddVisitor />} />
              <Route path="users/visitors/edit/:id" element={<EditVisitor />} />
              <Route path="users/roles" element={<Roles />} />
              <Route path="users/permissions" element={<PermissionsTable />} />

              {/* ✅ Aliases for legacy /dashboard/employee/... paths */}
              <Route path="employee/employees" element={<Employees />} />
              <Route path="employee/visitors" element={<Visitors />} />
              <Route path="employee/user/:employeeId" element={<UserOverview />} />
              <Route path="employee/employees/user/:employeeId" element={<UserOverview />} />
              <Route path="employee/visitors/user/:employeeId" element={<UserOverview />} />
              <Route path="employee/visitors/add" element={<AddVisitor />} />
              <Route path="employee/visitors/edit/:id" element={<EditVisitor />} />
              <Route
                path="employee/attendance"
                element={
                  canReadAttendance
                    ? <Attendance />
                    : <Dashboard />
                }
              />
              <Route path="employee/device" element={<Device />} />
              <Route path="employee/activity" element={<ActivityPgae />} />
              <Route path="employee/settings" element={<Settings />} />
              <Route
                path="employee/location"
                element={canReadLocation ? <LocationList /> : <Dashboard />}
              />

              {/* ✅ Attendance */}
              <Route
                path="users/attendance"
                element={
                  canReadAttendance
                    ? <Attendance />
                    : <Dashboard />
                }
              />

              {/* ✅ Contractors, RFID, Device, Zones */}
              <Route path="users/contractor" element={<Contractors />} />
              <Route path="users/rfid" element={<Rfid />} />
              <Route path="users/device" element={<Device />} />
              <Route path="users/zones" element={<Zones />} />
              <Route
                path="users/location"
                element={canReadLocation ? <LocationList /> : <Dashboard />}
              />
              <Route path="users/activity" element={<ActivityPgae />} />
              <Route path="users/settings" element={<Settings />} />


              <Route
                path="users/location/add"
                element={canCreateLocation ? <LocationAdd /> : <Dashboard />}
              />
              <Route
                path="users/location/edit/:id"
                element={canUpdateLocation ? <LocationEdit /> : <Dashboard />}
              />



              {/* ✅ Settings */}
              <Route path="settings/fields" element={<Fields />} />

              {/* 🔔 Notifications (FIXED PATH) */}
              <Route path="notifications" element={<NotificationsPage />} />
              {/* 📩 Enquiries (FIXED PATH) */}
              <Route path="enquiries" element={<EnquiriesPage />} />
              {/* ⚠️ Warnings */}
              <Route path="warnings" element={<WarningsPage />} />
              {/* 📦 Policy Packages */}
              <Route path="users/policy-packages" element={<PolicyPackagesList />} />
              <Route path="employee/policy-packages" element={<PolicyPackagesList />} />
              {/* 📸 Events (SuperAdmin Only) */}
              <Route path="users/events" element={<EventsList />} />


              {/* ✅ Default fallback */}
              <Route path="*" element={<Dashboard />} />
            </Routes>
          </div>
        </main>

        <Footer />
      </div>
    </div >
  );
}

export default DashboardLayout;
