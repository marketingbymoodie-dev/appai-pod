import { useLocation } from "wouter";
import AdminLayout from "@/components/admin-layout";
import PlanPicker from "./plan-picker";
import { useQueryClient } from "@tanstack/react-query";

export default function AdminPlanPickerPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  return (
    <AdminLayout>
      <PlanPicker
        inline
        onActivated={() => {
          queryClient.invalidateQueries({ queryKey: ["/api/appai/plan"] });
          queryClient.invalidateQueries({ queryKey: ["/api/appai/customizer-pages"] });
          navigate("/admin/customizer-pages");
        }}
      />
    </AdminLayout>
  );
}
