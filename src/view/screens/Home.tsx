import React from 'react'
import {FlatList, View} from 'react-native'
import {useFocusEffect, useIsFocused} from '@react-navigation/native'
import {AppBskyFeedGetFeed as GetCustomFeed} from '@atproto/api'
import {observer} from 'mobx-react-lite'
import useAppState from 'react-native-appstate-hook'
import isEqual from 'lodash.isequal'
import {NativeStackScreenProps, HomeTabNavigatorParams} from 'lib/routes/types'
import {PostsFeedModel} from 'state/models/feeds/posts'
import {withAuthRequired} from 'view/com/auth/withAuthRequired'
import {useTabFocusEffect} from 'lib/hooks/useTabFocusEffect'
import {Feed} from '../com/posts/Feed'
import {FollowingEmptyState} from 'view/com/posts/FollowingEmptyState'
import {CustomFeedEmptyState} from 'view/com/posts/CustomFeedEmptyState'
import {LoadLatestBtn} from '../com/util/load-latest/LoadLatestBtn'
import {FeedsTabBar} from '../com/pager/FeedsTabBar'
import {Pager, PagerRef, RenderTabBarFnProps} from 'view/com/pager/Pager'
import {FAB} from '../com/util/fab/FAB'
import {useStores} from 'state/index'
import {s} from 'lib/styles'
import {useOnMainScroll} from 'lib/hooks/useOnMainScroll'
import {useAnalytics} from 'lib/analytics'
import {ComposeIcon2} from 'lib/icons'
import {isDesktopWeb} from 'platform/detection'

const HEADER_OFFSET = isDesktopWeb ? 50 : 78
const POLL_FREQ = 30e3 // 30sec

type Props = NativeStackScreenProps<HomeTabNavigatorParams, 'Home'>
export const HomeScreen = withAuthRequired(
  observer((_opts: Props) => {
    const store = useStores()
    const pagerRef = React.useRef<PagerRef>(null)
    const [selectedPage, setSelectedPage] = React.useState(0)
    const [customFeeds, setCustomFeeds] = React.useState<PostsFeedModel[]>([])

    React.useEffect(() => {
      const {pinned} = store.me.savedFeeds
      if (
        isEqual(
          pinned.map(p => p.uri),
          customFeeds.map(f => (f.params as GetCustomFeed.QueryParams).feed),
        )
      ) {
        // no changes
        return
      }

      const feeds = []
      for (const feed of pinned) {
        const model = new PostsFeedModel(store, 'custom', {feed: feed.uri})
        model.setup()
        feeds.push(model)
      }
      pagerRef.current?.setPage(0)
      setCustomFeeds(feeds)
    }, [
      store,
      store.me.savedFeeds.pinned,
      customFeeds,
      setCustomFeeds,
      pagerRef,
    ])

    useFocusEffect(
      React.useCallback(() => {
        store.shell.setMinimalShellMode(false)
        store.shell.setIsDrawerSwipeDisabled(selectedPage > 0)
        return () => {
          store.shell.setIsDrawerSwipeDisabled(false)
        }
      }, [store, selectedPage]),
    )

    const onPageSelected = React.useCallback(
      (index: number) => {
        store.shell.setMinimalShellMode(false)
        setSelectedPage(index)
        store.shell.setIsDrawerSwipeDisabled(index > 0)
      },
      [store, setSelectedPage],
    )

    const onPressSelected = React.useCallback(() => {
      store.emitScreenSoftReset()
    }, [store])

    const renderTabBar = React.useCallback(
      (props: RenderTabBarFnProps) => {
        return (
          <FeedsTabBar
            {...props}
            testID="homeScreenFeedTabs"
            onPressSelected={onPressSelected}
          />
        )
      },
      [onPressSelected],
    )

    const renderFollowingEmptyState = React.useCallback(() => {
      return <FollowingEmptyState />
    }, [])

    const renderCustomFeedEmptyState = React.useCallback(() => {
      return <CustomFeedEmptyState />
    }, [])

    return (
      <Pager
        ref={pagerRef}
        testID="homeScreen"
        onPageSelected={onPageSelected}
        renderTabBar={renderTabBar}
        tabBarPosition="top">
        <FeedPage
          key="1"
          testID="followingFeedPage"
          isPageFocused={selectedPage === 0}
          feed={store.me.mainFeed}
          renderEmptyState={renderFollowingEmptyState}
        />
        {customFeeds.map((f, index) => {
          return (
            <FeedPage
              key={(f.params as GetCustomFeed.QueryParams).feed}
              testID="customFeedPage"
              isPageFocused={selectedPage === 1 + index}
              feed={f}
              renderEmptyState={renderCustomFeedEmptyState}
            />
          )
        })}
      </Pager>
    )
  }),
)

const FeedPage = observer(
  ({
    testID,
    isPageFocused,
    feed,
    renderEmptyState,
  }: {
    testID?: string
    feed: PostsFeedModel
    isPageFocused: boolean
    renderEmptyState?: () => JSX.Element
  }) => {
    const store = useStores()
    const [onMainScroll, isScrolledDown, resetMainScroll] =
      useOnMainScroll(store)
    const {screen, track} = useAnalytics()
    const scrollElRef = React.useRef<FlatList>(null)
    const {appState} = useAppState({
      onForeground: () => doPoll(true),
    })
    const isScreenFocused = useIsFocused()

    const doPoll = React.useCallback(
      (knownActive = false) => {
        if (
          (!knownActive && appState !== 'active') ||
          !isScreenFocused ||
          !isPageFocused
        ) {
          return
        }
        if (feed.isLoading) {
          return
        }
        store.log.debug('HomeScreen: Polling for new posts')
        feed.checkForLatest()
      },
      [appState, isScreenFocused, isPageFocused, store, feed],
    )

    const scrollToTop = React.useCallback(() => {
      scrollElRef.current?.scrollToOffset({offset: -HEADER_OFFSET})
      resetMainScroll()
    }, [scrollElRef, resetMainScroll])

    const onSoftReset = React.useCallback(() => {
      if (isPageFocused) {
        scrollToTop()
        feed.refresh()
      }
    }, [isPageFocused, scrollToTop, feed])

    // fires when screen is activated/deactivated
    // - set up polls/listeners, update content
    useFocusEffect(
      React.useCallback(() => {
        const softResetSub = store.onScreenSoftReset(onSoftReset)
        const feedCleanup = feed.registerListeners()
        const pollInterval = setInterval(doPoll, POLL_FREQ)

        screen('Feed')
        store.log.debug('HomeScreen: Updating feed')
        if (feed.hasContent) {
          feed.update()
        }

        return () => {
          clearInterval(pollInterval)
          softResetSub.remove()
          feedCleanup()
        }
      }, [store, doPoll, onSoftReset, screen, feed]),
    )
    // fires when tab is activated/deactivated
    // - check for latest
    useTabFocusEffect(
      'Home',
      React.useCallback(
        isInside => {
          if (!isPageFocused || !isInside) {
            return
          }
          feed.checkForLatest()
        },
        [isPageFocused, feed],
      ),
    )
    // fires when page within screen is activated/deactivated
    // - check for latest
    React.useEffect(() => {
      if (isPageFocused && isScreenFocused) {
        feed.checkForLatest()
      }
    }, [isPageFocused, isScreenFocused, feed])

    const onPressCompose = React.useCallback(() => {
      track('HomeScreen:PressCompose')
      store.shell.openComposer({})
    }, [store, track])

    const onPressTryAgain = React.useCallback(() => {
      feed.refresh()
    }, [feed])

    const onPressLoadLatest = React.useCallback(() => {
      scrollToTop()
      feed.refresh()
    }, [feed, scrollToTop])

    const hasNew = feed.hasNewLatest && !feed.isRefreshing
    return (
      <View testID={testID} style={s.h100pct}>
        <Feed
          testID={testID ? `${testID}-feed` : undefined}
          key="default"
          feed={feed}
          scrollElRef={scrollElRef}
          showPostFollowBtn
          onPressTryAgain={onPressTryAgain}
          onScroll={onMainScroll}
          scrollEventThrottle={100}
          renderEmptyState={renderEmptyState}
          headerOffset={HEADER_OFFSET}
        />
        {(isScrolledDown || hasNew) && (
          <LoadLatestBtn
            onPress={onPressLoadLatest}
            label="Load new posts"
            showIndicator={hasNew}
            minimalShellMode={store.shell.minimalShellMode}
          />
        )}
        <FAB
          testID="composeFAB"
          onPress={onPressCompose}
          icon={<ComposeIcon2 strokeWidth={1.5} size={29} style={s.white} />}
          accessibilityRole="button"
          accessibilityLabel="Compose post"
          accessibilityHint=""
        />
      </View>
    )
  },
)
