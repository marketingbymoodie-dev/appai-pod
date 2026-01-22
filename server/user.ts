import { supabaseAdmin } from "./supabase";

export type AppUser = {
  id: string;
  shop: string;
  customer_id: string;
  is_merchant: boolean;
  created_at: string;
};

type GetOrCreateUserArgs = {
  shop: string;
  customerId: string;
  isMerchant?: boolean;
};

export async function getOrCreateUser({
  shop,
  customerId,
  isMerchant = false,
}: GetOrCreateUserArgs): Promise<AppUser> {
  // 1. Try to find existing user
  const { data: existingUser, error: findError } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("shop", shop)
    .eq("customer_id", customerId)
    .single();

  if (existingUser && !findError) {
    return existingUser;
  }

  // 2. Create user if not found
  const { data: newUser, error: insertError } = await supabaseAdmin
    .from("users")
    .insert({
      shop,
      customer_id: customerId,
      is_merchant: isMerchant,
    })
    .select()
    .single();

  if (insertError || !newUser) {
    throw new Error("Failed to create user");
  }

  // 3. Give starting credits
  await supabaseAdmin.from("credits").insert({
    user_id: newUser.id,
    balance: isMerchant ? 0 : 5, // customers get 5 free generations
  });

  return newUser;
}
