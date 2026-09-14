export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      audit_log: {
        Row: {
          action: string
          after: Json | null
          before: Json | null
          created_at: string
          entity: string
          entity_id: string | null
          id: string
          session_id: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          after?: Json | null
          before?: Json | null
          created_at?: string
          entity: string
          entity_id?: string | null
          id?: string
          session_id?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          after?: Json | null
          before?: Json | null
          created_at?: string
          entity?: string
          entity_id?: string | null
          id?: string
          session_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      export_jobs: {
        Row: {
          created_at: string
          files: Json | null
          id: string
          langs: string[]
          mode: string
          session_id: string
          status: Database["public"]["Enums"]["export_status"]
        }
        Insert: {
          created_at?: string
          files?: Json | null
          id?: string
          langs?: string[]
          mode: string
          session_id: string
          status?: Database["public"]["Enums"]["export_status"]
        }
        Update: {
          created_at?: string
          files?: Json | null
          id?: string
          langs?: string[]
          mode?: string
          session_id?: string
          status?: Database["public"]["Enums"]["export_status"]
        }
        Relationships: [
          {
            foreignKeyName: "export_jobs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      insights: {
        Row: {
          at_ms: number
          created_at: string
          id: string
          session_id: string
          text: string
        }
        Insert: {
          at_ms: number
          created_at?: string
          id?: string
          session_id: string
          text: string
        }
        Update: {
          at_ms?: number
          created_at?: string
          id?: string
          session_id?: string
          text?: string
        }
        Relationships: [
          {
            foreignKeyName: "insights_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string
          free_sessions_left: number
          id: string
          name: string | null
          plan: string
          retention_days: number
        }
        Insert: {
          created_at?: string
          email: string
          free_sessions_left?: number
          id: string
          name?: string | null
          plan?: string
          retention_days?: number
        }
        Update: {
          created_at?: string
          email?: string
          free_sessions_left?: number
          id?: string
          name?: string | null
          plan?: string
          retention_days?: number
        }
        Relationships: []
      }
      questions: {
        Row: {
          created_at: string
          good_signal: string | null
          id: string
          must: boolean
          note: string | null
          order_idx: number
          purpose: string | null
          selected_at: string | null
          session_id: string
          source: Database["public"]["Enums"]["question_source"]
          status: Database["public"]["Enums"]["question_status"]
          text: string
        }
        Insert: {
          created_at?: string
          good_signal?: string | null
          id?: string
          must?: boolean
          note?: string | null
          order_idx?: number
          purpose?: string | null
          selected_at?: string | null
          session_id: string
          source?: Database["public"]["Enums"]["question_source"]
          status?: Database["public"]["Enums"]["question_status"]
          text: string
        }
        Update: {
          created_at?: string
          good_signal?: string | null
          id?: string
          must?: boolean
          note?: string | null
          order_idx?: number
          purpose?: string | null
          selected_at?: string | null
          session_id?: string
          source?: Database["public"]["Enums"]["question_source"]
          status?: Database["public"]["Enums"]["question_status"]
          text?: string
        }
        Relationships: [
          {
            foreignKeyName: "questions_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limit_counters: {
        Row: {
          count: number
          key: string
          window_start: string
        }
        Insert: {
          count?: number
          key: string
          window_start: string
        }
        Update: {
          count?: number
          key?: string
          window_start?: string
        }
        Relationships: []
      }
      report_jobs: {
        Row: {
          data: Json | null
          error: string | null
          id: string
          session_id: string
          step: number
          step_status: Database["public"]["Enums"]["report_job_status"]
          updated_at: string
        }
        Insert: {
          data?: Json | null
          error?: string | null
          id?: string
          session_id: string
          step: number
          step_status?: Database["public"]["Enums"]["report_job_status"]
          updated_at?: string
        }
        Update: {
          data?: Json | null
          error?: string | null
          id?: string
          session_id?: string
          step?: number
          step_status?: Database["public"]["Enums"]["report_job_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_jobs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      reports: {
        Row: {
          cautions: Json | null
          created_at: string
          edited_by_user: boolean
          evidence: Json | null
          generated_at: string | null
          id: string
          scorecard: Json | null
          session_id: string
          status: Database["public"]["Enums"]["report_status"]
          strengths: Json | null
        }
        Insert: {
          cautions?: Json | null
          created_at?: string
          edited_by_user?: boolean
          evidence?: Json | null
          generated_at?: string | null
          id?: string
          scorecard?: Json | null
          session_id: string
          status?: Database["public"]["Enums"]["report_status"]
          strengths?: Json | null
        }
        Update: {
          cautions?: Json | null
          created_at?: string
          edited_by_user?: boolean
          evidence?: Json | null
          generated_at?: string | null
          id?: string
          scorecard?: Json | null
          session_id?: string
          status?: Database["public"]["Enums"]["report_status"]
          strengths?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "reports_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      sessions: {
        Row: {
          candidate_name: string | null
          cap_seconds: number
          created_at: string
          cv_error: string | null
          cv_file_id: string | null
          cv_file_path: string | null
          cv_status: Database["public"]["Enums"]["cv_status_type"]
          cv_text: string | null
          duration_sec: number | null
          ended_at: string | null
          ended_reason: Database["public"]["Enums"]["ended_reason_type"] | null
          id: string
          jd_text: string | null
          kind: string
          last_seq: number
          mode: Database["public"]["Enums"]["session_mode"]
          position: string | null
          purge_scheduled_at: string | null
          quick_eval: Json | null
          quota_debited: boolean
          quota_refunded: boolean
          recording_started_at: string | null
          share_expires_at: string | null
          share_token: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["session_status"]
          translation_lang: string
          user_id: string
          wish_text: string | null
        }
        Insert: {
          candidate_name?: string | null
          cap_seconds?: number
          created_at?: string
          cv_error?: string | null
          cv_file_id?: string | null
          cv_file_path?: string | null
          cv_status?: Database["public"]["Enums"]["cv_status_type"]
          cv_text?: string | null
          duration_sec?: number | null
          ended_at?: string | null
          ended_reason?: Database["public"]["Enums"]["ended_reason_type"] | null
          id?: string
          jd_text?: string | null
          kind?: string
          last_seq?: number
          mode?: Database["public"]["Enums"]["session_mode"]
          position?: string | null
          purge_scheduled_at?: string | null
          quick_eval?: Json | null
          quota_debited?: boolean
          quota_refunded?: boolean
          recording_started_at?: string | null
          share_expires_at?: string | null
          share_token?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["session_status"]
          translation_lang?: string
          user_id: string
          wish_text?: string | null
        }
        Update: {
          candidate_name?: string | null
          cap_seconds?: number
          created_at?: string
          cv_error?: string | null
          cv_file_id?: string | null
          cv_file_path?: string | null
          cv_status?: Database["public"]["Enums"]["cv_status_type"]
          cv_text?: string | null
          duration_sec?: number | null
          ended_at?: string | null
          ended_reason?: Database["public"]["Enums"]["ended_reason_type"] | null
          id?: string
          jd_text?: string | null
          kind?: string
          last_seq?: number
          mode?: Database["public"]["Enums"]["session_mode"]
          position?: string | null
          purge_scheduled_at?: string | null
          quick_eval?: Json | null
          quota_debited?: boolean
          quota_refunded?: boolean
          recording_started_at?: string | null
          share_expires_at?: string | null
          share_token?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["session_status"]
          translation_lang?: string
          user_id?: string
          wish_text?: string | null
        }
        Relationships: []
      }
      suggestions: {
        Row: {
          created_at: string
          id: string
          session_id: string
          status: Database["public"]["Enums"]["suggestion_status"]
          text: string
        }
        Insert: {
          created_at?: string
          id?: string
          session_id: string
          status?: Database["public"]["Enums"]["suggestion_status"]
          text: string
        }
        Update: {
          created_at?: string
          id?: string
          session_id?: string
          status?: Database["public"]["Enums"]["suggestion_status"]
          text?: string
        }
        Relationships: [
          {
            foreignKeyName: "suggestions_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      utterances: {
        Row: {
          client_utt_id: string | null
          created_at: string
          en_pending: boolean
          id: string
          lang: string | null
          question_id: string | null
          seq: number
          session_id: string
          speaker: Database["public"]["Enums"]["speaker_role"]
          t_end_ms: number | null
          t_start_ms: number | null
          text_orig: string
          translations: Json | null
        }
        Insert: {
          client_utt_id?: string | null
          created_at?: string
          en_pending?: boolean
          id?: string
          lang?: string | null
          question_id?: string | null
          seq: number
          session_id: string
          speaker: Database["public"]["Enums"]["speaker_role"]
          t_end_ms?: number | null
          t_start_ms?: number | null
          text_orig: string
          translations?: Json | null
        }
        Update: {
          client_utt_id?: string | null
          created_at?: string
          en_pending?: boolean
          id?: string
          lang?: string | null
          question_id?: string | null
          seq?: number
          session_id?: string
          speaker?: Database["public"]["Enums"]["speaker_role"]
          t_end_ms?: number | null
          t_start_ms?: number | null
          text_orig?: string
          translations?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "utterances_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "utterances_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      bump_rate_limit: {
        Args: { p_key: string; p_limit: number; p_window: string }
        Returns: boolean
      }
      debit_free_session: { Args: { p_session: string }; Returns: number }
      get_shared_report: { Args: { p_token: string }; Returns: Json }
      next_utterance_seq: { Args: { p_session: string }; Returns: number }
      refund_free_session: { Args: { p_session: string }; Returns: number }
    }
    Enums: {
      cv_status_type: "none" | "reading" | "done" | "failed"
      ended_reason_type: "user" | "cap" | "error"
      export_status: "pending" | "ready" | "failed"
      question_source: "generated" | "manual" | "suggestion"
      question_status: "pending" | "active" | "done" | "weak"
      report_job_status: "pending" | "running" | "done" | "failed"
      report_status: "pending" | "ready" | "failed"
      session_mode: "online" | "direct"
      session_status: "prep" | "live" | "processing" | "done" | "failed"
      speaker_role: "interviewer" | "candidate"
      suggestion_status: "shown" | "added" | "skipped"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      cv_status_type: ["none", "reading", "done", "failed"],
      ended_reason_type: ["user", "cap", "error"],
      export_status: ["pending", "ready", "failed"],
      question_source: ["generated", "manual", "suggestion"],
      question_status: ["pending", "active", "done", "weak"],
      report_job_status: ["pending", "running", "done", "failed"],
      report_status: ["pending", "ready", "failed"],
      session_mode: ["online", "direct"],
      session_status: ["prep", "live", "processing", "done", "failed"],
      speaker_role: ["interviewer", "candidate"],
      suggestion_status: ["shown", "added", "skipped"],
    },
  },
} as const
