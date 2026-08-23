import React, { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { ScreenHeader } from '@/components/ui';
import { useColors } from '@/hooks/useColors';

type ReleaseNote = {
  date: string;
  updates: { title: string; description: string }[];
};

const RELEASE_NOTES: ReleaseNote[] = [
  {
    date: 'August 23, 2026',
    updates: [
      {
        title: 'New mobile experience',
        description:
          'A dedicated mobile companion brings season-aware Results, auction history, trades, source links, and signed long/short positions to your phone.',
      },
      {
        title: 'Trade legs stay together',
        description:
          'Multi-leg transactions appear as one expandable trade summary with the aggregate value, teams, counterparties, date, and status up front.',
      },
      {
        title: 'Short positions are shown accurately',
        description:
          'Results preserves signed long and short ownership so exposure and returns reflect the actual position.',
      },
      {
        title: 'Trace a position to its source',
        description:
          'Tap an auction or trade entry in Results to open the original record, then return to Results with one touch.',
      },
    ],
  },
];

function FaqCard() {
  const colors = useColors();
  const [open, setOpen] = useState<boolean>(true);

  return (
    <View style={[styles.faqCard, { borderColor: colors.border, backgroundColor: colors.card }]}>
      <Pressable
        onPress={() => setOpen((value) => !value)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [styles.faqSummary, { opacity: pressed ? 0.72 : 1 }]}
      >
        <Text style={[styles.faqQuestion, { color: colors.foreground }]}>
          How do I connect MCP or the API?
        </Text>
        <Feather
          name={open ? 'minus' : 'plus'}
          size={17}
          color={colors.mutedForeground}
        />
      </Pressable>
      {open ? (
        <View style={[styles.faqAnswer, { borderTopColor: colors.border }]}>
          <Text style={[styles.body, { color: colors.mutedForeground }]}>
            Connect an MCP-compatible client to this app’s base URL plus{' '}
            <Text style={[styles.code, { color: colors.foreground }]}>/api/mcp</Text>. The
            endpoint accepts stateless Streamable HTTP POST requests.
          </Text>
          <View style={[styles.endpointBox, { borderColor: colors.border, backgroundColor: colors.muted }]}>
            <Text style={[styles.endpointText, { color: colors.foreground }]}>
              Authorization: Bearer &lt;MCP_API_KEY&gt;
            </Text>
            <Text style={[styles.endpointText, { color: colors.mutedForeground }]}>
              Endpoint: /api/mcp
            </Text>
          </View>
          <Text style={[styles.body, { color: colors.mutedForeground }]}>
            Commissioner approvals use a separate admin authorization. Reach out to the
            commissioner for the relevant key and never share it publicly.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export default function WhatsNewScreen() {
  const colors = useColors();
  const bottomPadding = Platform.OS === 'web' ? 100 : 32;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="What’s New" subtitle="Release notes & FAQ" />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomPadding }]}>
        <View style={styles.titleRow}>
          <View style={[styles.iconBox, { backgroundColor: `${colors.primary}16`, borderColor: `${colors.primary}55` }]}>
            <Feather name="star" size={18} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Release history</Text>
            <Text style={[styles.sectionSubtitle, { color: colors.mutedForeground }]}>
              Most recent updates appear first.
            </Text>
          </View>
        </View>

        {RELEASE_NOTES.map((release) => (
          <View
            key={release.date}
            style={[styles.releaseCard, { borderColor: `${colors.primary}55`, backgroundColor: `${colors.primary}0D` }]}
          >
            <Text style={[styles.releaseDate, { color: colors.primary }]}>{release.date}</Text>
            {release.updates.map((update) => (
              <View key={update.title} style={styles.updateRow}>
                <View style={[styles.updateDot, { backgroundColor: colors.primary }]} />
                <Text style={[styles.body, { color: colors.mutedForeground, flex: 1 }]}>
                  <Text style={[styles.updateTitle, { color: colors.foreground }]}>{update.title}. </Text>
                  {update.description}
                </Text>
              </View>
            ))}
          </View>
        ))}

        <View style={styles.faqHeading}>
          <Feather name="help-circle" size={16} color={colors.primary} />
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>FAQ</Text>
        </View>
        <FaqCard />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 16,
    paddingTop: 18,
    gap: 14,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconBox: {
    width: 38,
    height: 38,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionTitle: {
    fontSize: 14,
    fontFamily: 'Archivo_700Bold',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  sectionSubtitle: {
    fontSize: 10,
    fontFamily: 'JetBrainsMono_400Regular',
    marginTop: 2,
  },
  releaseCard: {
    borderWidth: 1,
    padding: 14,
    gap: 12,
  },
  releaseDate: {
    fontSize: 11,
    fontFamily: 'JetBrainsMono_700Bold',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  updateRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  updateDot: {
    width: 5,
    height: 5,
    borderRadius: 99,
    marginTop: 7,
  },
  body: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
    lineHeight: 19,
  },
  updateTitle: {
    fontFamily: 'Archivo_700Bold',
  },
  faqHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 8,
  },
  faqCard: {
    borderWidth: 1,
  },
  faqSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
  },
  faqQuestion: {
    flex: 1,
    fontSize: 13,
    fontFamily: 'Archivo_700Bold',
  },
  faqAnswer: {
    borderTopWidth: 1,
    padding: 14,
    gap: 12,
  },
  code: {
    fontFamily: 'JetBrainsMono_700Bold',
  },
  endpointBox: {
    borderWidth: 1,
    padding: 10,
    gap: 4,
  },
  endpointText: {
    fontSize: 10,
    fontFamily: 'JetBrainsMono_400Regular',
  },
});