import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { getQueryFn } from "@/lib/queryClient";
import type { User } from "@shared/models/auth";

async function logout(): Promise<void> {
  window.location.href = "/api/logout";
}

export function useAuth() {
  const queryClient = useQueryClient();
  const [forceLoaded, setForceLoaded] = useState(false);

  // Failsafe: force loading to complete after 10 seconds no matter what
  useEffect(() => {
    const timer = setTimeout(() => {
      console.log("[useAuth] Failsafe timeout - forcing loaded state");
      setForceLoaded(true);
    }, 10000);
    return () => clearTimeout(timer);
  }, []);

  const { data: user, isLoading: queryLoading, error, status, fetchStatus } = useQuery<User | null>({
    queryKey: ["/api/auth/user"],
    queryFn: getQueryFn<User | null>({ on401: "returnNull" }),
    retry: false,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  // If failsafe triggered, pretend we're not loading
  const isLoading = forceLoaded ? false : queryLoading;

  // Debug logging
  console.log("[useAuth] state:", { user: user ? "exists" : "null", isLoading, queryLoading, forceLoaded, status, fetchStatus, error: error?.message });

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.setQueryData(["/api/auth/user"], null);
    },
  });

  return {
    user,
    isLoading,
    isAuthenticated: !!user,
    logout: logoutMutation.mutate,
    isLoggingOut: logoutMutation.isPending,
  };
}
