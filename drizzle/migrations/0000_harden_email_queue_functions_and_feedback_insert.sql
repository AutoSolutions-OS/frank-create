ALTER FUNCTION public.move_to_dlq(text,text,bigint,jsonb) SET search_path = '';
ALTER FUNCTION public.read_email_batch(text,integer,integer) SET search_path = '';
ALTER FUNCTION public.enqueue_email(text,jsonb) SET search_path = '';
ALTER FUNCTION public.delete_email(text,bigint) SET search_path = '';
DROP POLICY IF EXISTS "feedback insert authenticated" ON public.feedback_items;
CREATE POLICY "feedback insert own" ON public.feedback_items FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());